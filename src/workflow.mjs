import { PortalSession, PortalSessionLostError, describeSnapshot } from './browser.mjs';
import {
  StateBusyError,
  acquireStateLock,
  createJournal,
  loadRecord,
  saveRecord,
  saveResult,
} from './coordination.mjs';

const MAX_ROUNDS = 3;
const MAX_STEPS = 24;

function now() {
  return new Date().toISOString();
}

function credential(panel) {
  return {
    state: panel?.state ?? 'unknown',
    requestId: panel?.requestId ?? null,
    receipt: panel?.receipt ?? null,
    used: panel?.used === true,
    expiresAt: panel?.expiresAt ?? null,
  };
}

function emptyRecord(requestId) {
  return {
    version: 1,
    requestId,
    state: 'in-progress',
    startedAt: now(),
    updatedAt: now(),
    attempts: 0,
    duplicateBookings: 0,
    boat: credential(null),
    equipment: credential(null),
    manualReasons: [],
    actions: [],
    observations: [],
    sessionLosses: 0,
  };
}

function snapshotFacts(snapshot) {
  return { boat: credential(snapshot?.boat), equipment: credential(snapshot?.equipment) };
}

function buildResult(record) {
  const last = record.observations.at(-1) ?? null;
  const result = {
    requestId: record.requestId,
    state: record.state,
    duplicateBookings: record.duplicateBookings ?? 0,
    boat: credential(record.boat),
    equipment: credential(record.equipment),
    manualReasons: record.manualReasons ?? [],
    notes: record.notes ?? [],
    evidence: {
      attempts: record.attempts,
      sessionLosses: record.sessionLosses ?? 0,
      actions: record.actions.map(entry => ({
        at: entry.at,
        action: entry.action,
        target: entry.target,
        status: entry.status,
        message: entry.message ?? null,
      })),
      observations: record.observations.length,
      lastObservation: last ? { at: last.at, ...snapshotFacts(last), duplicateBookings: last.duplicateBookings } : null,
    },
  };
  if (record.verification) result.verification = record.verification;
  return result;
}

function resultMatchesPortal(state, snapshot, requestId) {
  const boat = snapshot.boat;
  const equipment = snapshot.equipment;
  if (state === 'confirmed') {
    return boat.state === 'confirmed' && boat.requestId === requestId
      && equipment.state === 'confirmed' && equipment.requestId === requestId;
  }
  if (state === 'released') {
    return !['held', 'confirmed'].includes(boat.state) && !['held', 'confirmed'].includes(equipment.state);
  }
  return null;
}

function isTerminal(record) {
  return ['confirmed', 'released', 'manual'].includes(record?.state);
}

function recordNonManualNote(record, message, details = {}) {
  record.notes = record.notes ?? [];
  record.notes.push({ at: now(), message, ...details });
}

function addReason(record, code, message, details = {}) {
  if (record.manualReasons.some(reason => reason.code === code && reason.message === message)) return;
  record.manualReasons.push({ code, message, at: now(), ...details });
}

async function persist(record, stateDir) {
  record.updatedAt = now();
  await saveRecord(stateDir, record);
}

async function finish(record, stateDir, journal, outcome, extra = {}) {
  record.state = outcome;
  if (extra.reason) addReason(record, extra.reason.code, extra.reason.message, extra.reason.details);
  await persist(record, stateDir);
  const result = buildResult(record);
  await saveResult(stateDir, result);
  await journal.append('run-finish', { state: outcome, duplicateBookings: result.duplicateBookings, manualReasons: result.manualReasons });
  return result;
}

function createContext({ portalUrl, requestId, record, stateDir, journal, timeoutMs, hooks }) {
  let session = null;
  let steps = 0;

  const ctx = {
    record,
    stateDir,
    journal,
    get session() { return session; },
    get steps() { return steps; },
    takeStep() { steps += 1; return steps; },
    async openSession(reason) {
      await journal.append('session-open', { reason });
      session = await PortalSession.open({ url: portalUrl, requestId, timeoutMs });
      return session;
    },
    async closeSession(reason) {
      if (!session) return;
      const closing = session;
      session = null;
      await closing.close();
      await journal.append('session-closed', { reason });
    },
    async observe(reason) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if (!session) await ctx.openSession(reason);
          const raw = await session.lookup();
          const snapshot = describeSnapshot(raw);
          if (snapshot.lastOutcome === 'network-error') {
            // 页面状态可能是上次成功读取的旧值，不能当作门户当前事实。
            await journal.append('portal-unreadable', { reason, message: snapshot.lastMessage });
            return { unavailable: true, at: now(), reason: 'portal-unreachable', message: snapshot.lastMessage, ...snapshotFacts(ctx.record) };
          }
          ctx.record.observations.push(snapshot);
          ctx.record.duplicateBookings = snapshot.duplicateBookings ?? ctx.record.duplicateBookings;
          ctx.record.boat = credential(snapshot.boat);
          ctx.record.equipment = credential(snapshot.equipment);
          await persist(ctx.record, stateDir);
          await journal.append('observed', { reason, snapshot: snapshotFacts(snapshot), duplicateBookings: snapshot.duplicateBookings, ambiguity: snapshot.ambiguity });
          return snapshot;
        } catch (error) {
          if (!(error instanceof PortalSessionLostError) && !isLaunchFailure(error)) throw error;
          await journal.append('session-lost', { reason, message: error.message });
          await ctx.closeSession('lookup-lost');
          if (!isLaunchFailure(error)) continue;
          return { unavailable: true, at: now(), reason: 'portal-unreachable', message: error.message, ...snapshotFacts(ctx.record) };
        }
      }
      return { unavailable: true, at: now(), reason: 'portal-unreachable', message: '门户会话多次中断', ...snapshotFacts(ctx.record) };
    },
    async act(action, target, reason) {
      if (ctx.steps >= MAX_STEPS) return { status: 'budget', snapshot: null, message: '动作次数达到上限' };
      ctx.takeStep();
      await journal.append('intent', { action, target, reason });
      if (hooks?.beforeAction) await hooks.beforeAction({ action, target, reason, ctx });
      try {
        if (!session) await ctx.openSession('action');
        const raw = await session[action](target);
        const snapshot = describeSnapshot(raw);
        let status = 'accepted';
        if (snapshot.lastOutcome === 'rejected') status = 'rejected';
        else if (snapshot.lastOutcome === 'blocked') status = 'blocked';
        else if (snapshot.lastOutcome === 'network-error') status = 'ambiguous';
        else if (snapshot.ambiguity) status = 'ambiguous';
        ctx.record.observations.push(snapshot);
        ctx.record.actions.push({ at: now(), action, target, status, message: snapshot.lastMessage });
        ctx.record.duplicateBookings = snapshot.duplicateBookings ?? ctx.record.duplicateBookings;
        ctx.record.boat = credential(snapshot.boat);
        ctx.record.equipment = credential(snapshot.equipment);
        await persist(ctx.record, stateDir);
        await journal.append('outcome', { action, target, status, snapshot: snapshotFacts(snapshot), message: snapshot.lastMessage, duplicateBookings: snapshot.duplicateBookings });
        if (hooks?.afterAction) await hooks.afterAction({ action, target, status, snapshot });
        return { status, snapshot, message: snapshot.lastMessage };
      } catch (error) {
        if (error instanceof PortalSessionLostError || isLaunchFailure(error)) {
          await journal.append('outcome', { action, target, status: 'session-lost', message: error.message });
          ctx.record.actions.push({ at: now(), action, target, status: 'session-lost', message: error.message });
          ctx.record.sessionLosses += 1;
          await ctx.closeSession('action-lost');
          await persist(ctx.record, stateDir);
          if (hooks?.afterAction) await hooks.afterAction({ action, target, status: 'session-lost', error });
          return { status: 'lost', snapshot: null, message: error.message };
        }
        throw error;
      }
    },
  };
  return ctx;
}

function isLaunchFailure(error) {
  if (error instanceof PortalSessionLostError) return false;
  return /Executable doesn't exist|Cannot find module|EACCES|ENOENT|net::ERR_CONNECTION_REFUSED|ECONNREFUSED|ECONNRESET|net::ERR_CONNECTION_RESET|net::ERR_NAME_NOT_RESOLVED/i.test(error?.message ?? '');
}

function panelOf(snapshot, target) {
  return snapshot?.[target] ?? credential(null);
}

function isOurs(panel, requestId) {
  return panel.requestId === requestId;
}

function heldUsable(panel) {
  return ['held', 'confirmed', 'expired'].includes(panel.state);
}

function holdIsLive(panel) {
  return panel.state === 'held' && (panel.expiresAt == null || Number(panel.expiresAt) > Date.now());
}

function expiresInPast(panel) {
  return panel.expiresAt != null && Number(panel.expiresAt) <= Date.now();
}

async function ensureHold(ctx, target, requestId) {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (ctx.steps >= MAX_STEPS) return { status: 'budget', snapshot: null };
    const snapshot = await ctx.observe(`核对保留:${target}`);
    if (snapshot.unavailable) return { status: 'unavailable', snapshot };
    const panel = panelOf(snapshot, target);
    if (heldUsable(panel) && !isOurs(panel, requestId)) {
      return { status: 'conflict', snapshot, panel };
    }
    if (panel.state === 'held' && panel.used) {
      return { status: 'used', snapshot, panel };
    }
    if (panel.state === 'confirmed') {
      // 已确认（即使人工已经使用）属于同一请求的真实承诺，不重新占位、不取消。
      return { status: 'held', snapshot, panel, already: 'confirmed' };
    }
    if (panel.state === 'held' && holdIsLive(panel)) return { status: 'held', snapshot, panel };
    // 已过期限的同一请求保留不算有效占位，走续办；门户按业务编号识别为同一份。
    if (panel.state !== 'available' && panel.state !== 'expired' && !(panel.state === 'held' && !holdIsLive(panel))) {
      return { status: 'unexpected', snapshot, panel, message: `未知状态 ${panel.state}` };
    }
    const outcome = await ctx.act('hold', target, '取得保留');
    if (outcome.status === 'budget') return { status: 'budget', snapshot };
    if (outcome.status === 'lost' || outcome.status === 'ambiguous') continue;
    if (outcome.status === 'accepted') {
      const after = panelOf(outcome.snapshot, target);
      if (after.state === 'held' || after.state === 'confirmed') return { status: 'held', snapshot: outcome.snapshot, panel: after };
      continue;
    }
    return { status: 'rejected', snapshot: outcome.snapshot, panel: panelOf(outcome.snapshot, target), message: outcome.message };
  }
  return { status: 'exhausted', snapshot: await ctx.observe(`重试耗尽:${target}`) };
}

async function ensureConfirm(ctx, target, requestId) {
  let renewed = false;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (ctx.steps >= MAX_STEPS) return { status: 'budget', snapshot: null };
    const snapshot = await ctx.observe(`核对确认:${target}`);
    if (snapshot.unavailable) return { status: 'unavailable', snapshot };
    const panel = panelOf(snapshot, target);
    if (panel.used && panel.state === 'held') return { status: 'used', snapshot, panel };
    if (heldUsable(panel) && !isOurs(panel, requestId)) return { status: 'conflict', snapshot, panel };
    if (panel.state === 'confirmed' && isOurs(panel, requestId)) return { status: 'confirmed', snapshot, panel };
    if (panel.state === 'available') {
      // 保留在服务器侧消失且未被占用。同一请求重新取得保留后再确认，仍不会产生第二份。
      if (renewed) return { status: 'hold-lost', snapshot, panel };
      renewed = true;
      const hold = await ctx.act('hold', target, '保留已消失，重新取得');
      if (hold.status === 'budget') return { status: 'budget', snapshot };
      if (hold.status === 'lost' || hold.status === 'ambiguous') continue;
      if (hold.status === 'rejected' || hold.status === 'blocked') return { status: 'hold-lost', snapshot: hold.snapshot, panel: panelOf(hold.snapshot, target), message: hold.message };
      continue;
    }
    if (panel.state === 'expired' || (panel.state === 'held' && expiresInPast(panel))) {
      if (renewed) return { status: 'expired', snapshot, panel, message: '保留期限已过且无法续办' };
      renewed = true;
      const hold = await ctx.act('hold', target, '保留到期，续办同一请求');
      if (hold.status === 'budget') return { status: 'budget', snapshot };
      if (hold.status === 'lost' || hold.status === 'ambiguous') continue;
      if (hold.status === 'rejected' || hold.status === 'blocked') return { status: 'expired', snapshot: hold.snapshot, panel: panelOf(hold.snapshot, target), message: hold.message };
      continue;
    }
    if (panel.state !== 'held') return { status: 'unexpected', snapshot, panel, message: `未知状态 ${panel.state}` };
    const outcome = await ctx.act('confirm', target, '确认保留');
    if (outcome.status === 'budget') return { status: 'budget', snapshot };
    if (outcome.status === 'lost' || outcome.status === 'ambiguous') continue;
    if (outcome.status === 'accepted') {
      const after = panelOf(outcome.snapshot, target);
      if (after.state === 'confirmed' && isOurs(after, requestId)) return { status: 'confirmed', snapshot: outcome.snapshot, panel: after };
      if (panelOf(outcome.snapshot, target).used) return { status: 'used', snapshot: outcome.snapshot, panel: after };
      continue;
    }
    // 拒绝不等于没有确认：以回读为准，响应丢失时不能把业务结果当失败。
    const confirmCheck = await ctx.observe(`确认拒绝后回读:${target}`);
    if (confirmCheck.unavailable) return { status: 'unavailable', snapshot: confirmCheck };
    const checkPanel = panelOf(confirmCheck, target);
    if (checkPanel.state === 'confirmed' && isOurs(checkPanel, requestId)) {
      return { status: 'confirmed', snapshot: confirmCheck, panel: checkPanel, recovered: 'readback' };
    }
    if ((checkPanel.state === 'expired' || expiresInPast(checkPanel)) && !renewed) {
      renewed = true;
      const hold = await ctx.act('hold', target, '确认被拒后核对到期，续办同一请求');
      if (hold.status === 'budget') return { status: 'budget', snapshot: confirmCheck };
      if (hold.status === 'lost' || hold.status === 'ambiguous') continue;
      if (hold.status === 'accepted') continue;
    }
    return { status: 'rejected', snapshot: confirmCheck, panel: checkPanel, message: outcome.message };
  }
  return { status: 'exhausted', snapshot: await ctx.observe(`确认重试耗尽:${target}`) };
}

async function releaseIfUnused(ctx, target, requestId) {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const snapshot = await ctx.observe(`核对释放:${target}`);
    if (snapshot.unavailable) return { status: 'unavailable', snapshot };
    const panel = panelOf(snapshot, target);
    if (panel.used) return { status: 'used', snapshot, panel };
    if (heldUsable(panel) && !isOurs(panel, requestId)) return { status: 'conflict', snapshot, panel };
    if (panel.state === 'available') return { status: 'released', snapshot, panel };
    if (panel.state === 'confirmed' && isOurs(panel, requestId)) {
      // 已确认的预约是真实业务承诺，不用“回滚”取消。
      return { status: 'confirmed', snapshot, panel };
    }
    if (panel.state !== 'held' && panel.state !== 'expired') return { status: 'unexpected', snapshot, panel };
    const outcome = await ctx.act('release', target, '释放未使用的保留');
    if (outcome.status === 'budget') return { status: 'budget', snapshot };
    if (outcome.status === 'lost' || outcome.status === 'ambiguous') continue;
    if (outcome.status === 'accepted') continue;
  }
  return { status: 'failed', snapshot: await ctx.observe(`释放重试耗尽:${target}`) };
}

async function releaseBothUnused(ctx, requestId) {
  const equipment = await releaseIfUnused(ctx, 'equipment', requestId);
  if (equipment.status === 'used') addReason(ctx.record, 'equipment-used-by-staff', '设备已被工作人员实际使用，不能自动取消', { facts: snapshotFacts(equipment.snapshot ?? ctx.record) });
  else if (equipment.status === 'confirmed') addReason(ctx.record, 'equipment-confirmed-cannot-cancel', '设备已经确认，不能以回滚为名取消', { facts: snapshotFacts(equipment.snapshot ?? ctx.record) });
  else if (equipment.status === 'budget') addReason(ctx.record, 'budget-exhausted', '动作预算耗尽，设备保留未处理', { status: equipment.status });
  else if (equipment.status !== 'released') addReason(ctx.record, 'equipment-release-unconfirmed', '无法确认设备侧保留已释放', { facts: snapshotFacts(equipment.snapshot ?? ctx.record), status: equipment.status });

  const boat = await releaseIfUnused(ctx, 'boat', requestId);
  if (boat.status === 'used') addReason(ctx.record, 'boat-used-by-staff', '船位已被工作人员实际使用，不能自动取消', { facts: snapshotFacts(boat.snapshot ?? ctx.record) });
  else if (boat.status === 'confirmed') addReason(ctx.record, 'boat-confirmed-cannot-cancel', '船位已经确认，不能以回滚为名取消', { facts: snapshotFacts(boat.snapshot ?? ctx.record) });
  else if (boat.status === 'conflict') addReason(ctx.record, 'boat-booked-by-other', '船位保留属于其他请求，未擅自释放', { facts: snapshotFacts(boat.snapshot ?? ctx.record) });
  else if (boat.status === 'budget') addReason(ctx.record, 'budget-exhausted', '动作预算耗尽，船位保留未处理', { status: boat.status });
  else if (boat.status !== 'released') addReason(ctx.record, 'boat-release-unconfirmed', '无法确认船位侧保留已释放', { facts: snapshotFacts(boat.snapshot ?? ctx.record), status: boat.status });
  return { equipment, boat };
}

async function handleEquipmentHoldFailure(ctx, requestId, failure) {
  const snapshot = await ctx.observe('设备未取得保留后核对两侧');
  if (snapshot.unavailable) {
    addReason(ctx.record, 'portal-unreachable', '设备保留失败后门户失联，无法核对或补偿', { facts: snapshotFacts(ctx.record), failure: failure.status });
    return 'manual';
  }
  const equipment = panelOf(snapshot, 'equipment');
  if ((equipment.state === 'held' || equipment.state === 'confirmed') && isOurs(equipment, requestId)) {
    // 页面结果显示拒绝，但回读显示设备实际已保留；以回读事实继续，而不是重复预约。
    recordNonManualNote(ctx.record, '设备动作回读与页面结果不一致，按回读继续', {
      pageStatus: failure.status, pageMessage: failure.message ?? null, facts: snapshotFacts(snapshot),
    });
    return 'continue';
  }
  const rejectReason = {
    code: equipment.state === 'confirmed' || equipment.used ? 'equipment-occupied' : 'equipment-hold-rejected',
    message: equipment.state === 'confirmed' || equipment.used
      ? '设备侧已被实际占用，不能自动处理'
      : (failure.message ?? '设备未取得保留'),
    details: { facts: snapshotFacts(snapshot), pageStatus: failure.status },
  };
  const boat = panelOf(snapshot, 'boat');
  if (boat.used) {
    addReason(ctx.record, rejectReason.code, rejectReason.message, rejectReason.details);
    addReason(ctx.record, 'boat-used-by-staff', '船位已被工作人员实际使用，不能自动取消', { facts: snapshotFacts(snapshot) });
    return 'manual';
  }
  if (boat.state === 'confirmed' && isOurs(boat, requestId)) {
    addReason(ctx.record, rejectReason.code, rejectReason.message, rejectReason.details);
    addReason(ctx.record, 'boat-confirmed-equipment-unavailable', '船位已经确认但设备未成行，需要人工处理已确认的船位', { facts: snapshotFacts(snapshot) });
    return 'manual';
  }
  if (heldUsable(boat) && !isOurs(boat, requestId)) {
    addReason(ctx.record, rejectReason.code, rejectReason.message, rejectReason.details);
    addReason(ctx.record, 'boat-booked-by-other', '船位保留属于其他请求，未擅自释放', { facts: snapshotFacts(snapshot) });
    return 'manual';
  }
  if (boat.state === 'available') {
    recordNonManualNote(ctx.record, '设备未取得保留，船位未产生占用', { equipment: snapshotFacts(snapshot).equipment, failure: failure.status });
    return 'released';
  }
  if (boat.state === 'held' || boat.state === 'expired') {
    const released = await releaseIfUnused(ctx, 'boat', requestId);
    if (released.status === 'released') {
      recordNonManualNote(ctx.record, '设备未取得保留，船位保留已释放', { equipment: snapshotFacts(released.snapshot ?? ctx.record).equipment, failure: failure.status });
      return 'released';
    }
    addReason(ctx.record, rejectReason.code, rejectReason.message, rejectReason.details);
    if (released.status === 'used') {
      addReason(ctx.record, 'boat-used-by-staff', '释放船位时发现已被工作人员实际使用', { facts: snapshotFacts(released.snapshot ?? ctx.record) });
    } else if (released.status === 'confirmed') {
      addReason(ctx.record, 'boat-confirmed-cannot-cancel', '释放船位时发现已经确认，不能自动取消', { facts: snapshotFacts(released.snapshot ?? ctx.record) });
    } else {
      addReason(ctx.record, 'boat-hold-rollback-failed', '设备拒绝后无法确认船位已释放', { facts: snapshotFacts(released.snapshot ?? ctx.record), status: released.status });
    }
    return 'manual';
  }
  addReason(ctx.record, rejectReason.code, rejectReason.message, rejectReason.details);
  return 'manual';
}

async function coordinate(ctx, requestId) {
  const record = ctx.record;
  const initial = await ctx.observe('按业务编号核对已落盘进度');
  if (initial.unavailable) {
    addReason(record, 'portal-unreachable', '无法打开或核对门户，保留上次已落盘事实', { facts: snapshotFacts(record) });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }

  const boatHold = await ensureHold(ctx, 'boat', requestId);
  if (boatHold.status === 'unavailable' || boatHold.status === 'budget') {
    addReason(record, boatHold.status === 'budget' ? 'budget-exhausted' : 'portal-unreachable', '取得船位保留前无法核对门户，保留已落盘事实', {
      facts: snapshotFacts(record), status: boatHold.status,
    });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }
  if (boatHold.status === 'used') {
    addReason(record, 'boat-used-by-staff', '船位已被工作人员实际使用，不能自动取用或释放', { facts: snapshotFacts(boatHold.snapshot) });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }
  if (boatHold.status === 'conflict') {
    addReason(record, 'boat-booked-by-other', '船位保留属于其他请求，未重复预约也未擅自释放', { facts: snapshotFacts(boatHold.snapshot) });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }
  if (!['held'].includes(boatHold.status)) {
    await releaseBothUnused(ctx, requestId);
    addReason(record, 'boat-hold-unavailable', boatHold.message ?? '无法取得船位保留', { facts: snapshotFacts(boatHold.snapshot ?? record), status: boatHold.status });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }

  const equipmentHold = await ensureHold(ctx, 'equipment', requestId);
  if (equipmentHold.status !== 'held') {
    const outcome = await handleEquipmentHoldFailure(ctx, requestId, equipmentHold);
    if (outcome === 'continue') {
      // 回读显示设备实际已保留，继续走确认阶段。
    } else {
      if (outcome === 'released') {
        const final = await ctx.observe('设备失败释放后核对');
        if (final.unavailable) addReason(record, 'portal-unreachable', '释放船位后门户失联，无法确认最终状态', { facts: snapshotFacts(record) });
        else if (panelOf(final, 'boat').state !== 'available' && panelOf(final, 'boat').state !== 'confirmed') {
          addReason(record, 'boat-still-held-after-release', '释放后回读船位仍未可用', { facts: snapshotFacts(final) });
        }
      }
      return finish(record, ctx.stateDir, ctx.journal, record.manualReasons.length ? 'manual' : 'released');
    }
  }

  // 两侧都已保留，开始确认。先确认船位，再确认设备；任何一边确认后另一边拒绝都不能用取消已确认承诺来“回滚”。
  const boatConfirm = await ensureConfirm(ctx, 'boat', requestId);
  if (boatConfirm.status !== 'confirmed') {
    if (boatConfirm.status === 'used') {
      addReason(record, 'boat-used-by-staff', '确认阶段发现船位已被工作人员使用', { facts: snapshotFacts(boatConfirm.snapshot ?? record) });
      return finish(record, ctx.stateDir, ctx.journal, 'manual');
    }
    if (boatConfirm.status === 'conflict') {
      addReason(record, 'boat-booked-by-other', '确认阶段船位属于其他请求', { facts: snapshotFacts(boatConfirm.snapshot ?? record) });
      return finish(record, ctx.stateDir, ctx.journal, 'manual');
    }
    addReason(record, 'boat-confirm-failed', boatConfirm.message ?? '船位确认未完成', { facts: snapshotFacts(boatConfirm.snapshot ?? record), status: boatConfirm.status });
    // 船位未确认时两侧都还不是业务承诺，可释放未使用的保留。
    const releases = await releaseBothUnused(ctx, requestId);
    if (releases.boat.status === 'released' && releases.equipment.status === 'released') {
      const final = await ctx.observe('船位确认失败释放后核对');
      if (final.unavailable) {
        addReason(record, 'portal-unreachable', '释放后门户失联，无法确认最终状态', { facts: snapshotFacts(record) });
        return finish(record, ctx.stateDir, ctx.journal, 'manual');
      }
      const boatPanel = panelOf(final, 'boat');
      const equipmentPanel = panelOf(final, 'equipment');
      if (boatPanel.state === 'available' && (equipmentPanel.state === 'available' || equipmentPanel.state === 'expired')) {
        return finish(record, ctx.stateDir, ctx.journal, 'released');
      }
      addReason(record, 'release-readback-differs', '释放动作已执行但回读仍有未释放对象', { facts: snapshotFacts(final) });
    }
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }

  const equipmentConfirm = await ensureConfirm(ctx, 'equipment', requestId);
  if (equipmentConfirm.status !== 'confirmed') {
    if (equipmentConfirm.status === 'used') {
      addReason(record, 'equipment-used-by-staff', '设备已被工作人员实际使用，需人工处理', { facts: snapshotFacts(equipmentConfirm.snapshot ?? record) });
    } else if (equipmentConfirm.status === 'expired' || equipmentConfirm.status === 'hold-lost') {
      addReason(record, 'equipment-hold-lost', '设备保留未能续办，需要人工处理', { facts: snapshotFacts(equipmentConfirm.snapshot ?? record), status: equipmentConfirm.status });
    } else {
      addReason(record, 'equipment-confirm-failed', equipmentConfirm.message ?? '设备确认未完成', {
        facts: snapshotFacts(equipmentConfirm.snapshot ?? record), status: equipmentConfirm.status,
      });
    }
    const final = await ctx.observe('设备确认失败后核对两侧');
    if (final.unavailable) {
      addReason(record, 'portal-unreachable', '设备确认失败后门户失联，保留已确认船位并转人工', { facts: snapshotFacts(record) });
      return finish(record, ctx.stateDir, ctx.journal, 'manual');
    }
    const boatPanel = panelOf(final, 'boat');
    const equipmentPanel = panelOf(final, 'equipment');
    if (boatPanel.state === 'confirmed') {
      // 船位已经是真实承诺，设备失败只保留事实并转人工，不能释放船位。
      addReason(record, 'confirmed-boat-retained-for-staff', '船位已确认且设备未成行，等待人工决定后续', { facts: snapshotFacts(final) });
    } else if (equipmentPanel.state === 'confirmed') {
      addReason(record, 'confirmed-equipment-retained-for-staff', '设备已确认但船位异常，等待人工决定后续', { facts: snapshotFacts(final) });
    }
    if (equipmentPanel.state === 'held' && !equipmentPanel.used) {
      // 只有未确认且未使用的设备保留可以释放；已确认或已使用的绝不取消。
      await releaseIfUnused(ctx, 'equipment', requestId);
    }
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }

  const final = await ctx.observe('最终回读');
  if (final.unavailable) {
    addReason(record, 'portal-unreachable', '确认后门户失联，无法完成最终核对', { facts: snapshotFacts(record) });
    return finish(record, ctx.stateDir, ctx.journal, 'manual');
  }
  const boat = panelOf(final, 'boat');
  const equipment = panelOf(final, 'equipment');
  if (boat.state === 'confirmed' && equipment.state === 'confirmed' && isOurs(boat, requestId) && isOurs(equipment, requestId)) {
    return finish(record, ctx.stateDir, ctx.journal, 'confirmed');
  }
  addReason(record, 'final-readback-inconsistent', '最终回读未显示两侧均为同一请求的确认', { facts: snapshotFacts(final) });
  return finish(record, ctx.stateDir, ctx.journal, 'manual');
}

/**
 * 业务入口：只通过门户页面读取与操作，所有中间事实先落盘再继续。
 * 同一个 requestId 的重复执行以状态目录中的记录和门户回读为准。
 */
export async function run({ source, stateDir, input, hooks } = {}) {
  if (!source || typeof source !== 'string') throw new Error('缺少来源地址 source');
  if (!stateDir || typeof stateDir !== 'string') throw new Error('缺少状态目录 stateDir');
  const requestId = String(input?.requestId ?? '').trim();
  if (!requestId) throw new Error('缺少采样请求号 requestId');
  const timeoutMs = Number(input?.timeoutMs ?? 8000);

  let lock;
  try {
    lock = await acquireStateLock(stateDir, requestId);
  } catch (error) {
    if (error instanceof StateBusyError) throw error;
    throw error;
  }

  let journal;
  let record;
  let ctx;
  try {
    journal = await createJournal(stateDir, requestId);
    const existing = await loadRecord(stateDir, requestId);
    if (existing?.corrupt) throw new Error('协调记录已损坏，不能凭内存猜测，请人工核对门户与落盘事实：' + existing.path);
    if (existing && existing.requestId !== requestId) throw new Error('状态目录中的协调记录属于其他请求');
    const reused = Boolean(existing);
    record = existing ?? emptyRecord(requestId);
    if (reused && !isTerminal(record) && record.manualReasons?.length) {
      // 上次未到终态就中断，之前记录的原因只作为历史证据保留，不污染本次结论。
      record.notes = record.notes ?? [];
      for (const reason of record.manualReasons) record.notes.push({ ...reason, previousAttempt: true });
      record.manualReasons = [];
    }
    record.attempts += 1;
    record.state = isTerminal(record) ? record.state : 'in-progress';
    await persist(record, stateDir);
    await journal.append('run-start', { resume: reused, state: record.state, attempts: record.attempts });

    ctx = createContext({ portalUrl: source, requestId, record, stateDir, journal, timeoutMs, hooks });

    if (isTerminal(record)) {
      // 上一次已经形成最终业务事实：只读核对门户，不再点击任何写动作，避免多占。
      record.verification = { at: now(), reusedFrom: record.state };
      const snapshot = await ctx.observe('复用结果前核对门户');
      if (snapshot.unavailable) {
        record.verification = { ...record.verification, consistent: null, reason: 'portal-unreachable', facts: snapshotFacts(record) };
        addReason(record, 'portal-unreachable-on-reuse', '复用已落盘结果时门户不可达，仅保留上次事实，需人工核实', { facts: snapshotFacts(record) });
      } else {
        const matches = resultMatchesPortal(record.state, snapshot, requestId);
        record.verification = {
          ...record.verification,
          consistent: matches,
          facts: snapshotFacts(snapshot),
        };
        if (matches === false) {
          addReason(record, 'portal-differs-from-record', '门户回读与已落盘结果不一致，已保留两边事实，未自动补做或取消', {
            recordedState: record.state,
            facts: snapshotFacts(snapshot),
          });
          // 原先的 confirmed/released 承诺已不再被门户承认，业务上只能转人工。
          record.state = 'manual';
        }
        record.boat = credential(snapshot.boat);
        record.equipment = credential(snapshot.equipment);
        record.duplicateBookings = snapshot.duplicateBookings ?? record.duplicateBookings;
      }
      await persist(record, stateDir);
      const result = buildResult(record);
      await saveResult(stateDir, result);
      await journal.append('run-finish', { state: record.state, reused: true, duplicateBookings: result.duplicateBookings, verification: record.verification });
      return result;
    }

    return await coordinate(ctx, requestId);
  } finally {
    if (ctx) await ctx.closeSession('run-end').catch(() => {});
    if (journal) await journal.close().catch(() => {});
    await lock.release();
  }
}

export { StateBusyError };

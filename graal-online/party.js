'use strict';

// Ephemeral parties belong to authenticated socket sessions, never client claims.
module.exports = function createParties({ players, send, authorized, now = Date.now }) {
  const LIMIT = 5, TTL = 60000;
  const membership = new Map(), invitations = new Map(), rate = new Map();
  let nextId = 1;
  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const emit = (id, data) => { const p = players.get(id); if (p) send(p.ws, { t: 'party', ...data }); };
  const error = (p, message) => emit(p.id, { op: 'error', message });
  const view = group => group ? {
    id: group.id, leader: group.leader, limit: LIMIT,
    members: [...group.members].map(id => ({ id, nm: String(players.get(id)?.nm || '?').slice(0, 24) }))
  } : null;
  function state(id) {
    const pending = invitations.get(id);
    emit(id, { op: 'state', party: view(membership.get(id)), invitation: pending ? {
      from: pending.from, nm: String(players.get(pending.from)?.nm || '?').slice(0, 24),
      remaining: Math.max(0, pending.until - now())
    } : null });
  }
  function broadcast(group) { for (const id of group.members) state(id); }
  function clearInvites(predicate) {
    for (const [id, invite] of invitations) if (predicate(id, invite)) {
      invitations.delete(id); state(id);
    }
  }
  function expire() { clearInvites((id, invite) => invite.until <= now() || !live(players.get(invite.from))); }
  function remove(id) {
    const group = membership.get(id);
    membership.delete(id);
    clearInvites((target, invite) => target === id || invite.from === id);
    if (group) {
      group.members.delete(id);
      if (group.leader === id && group.members.size) group.leader = group.members.values().next().value;
      broadcast(group);
    }
    state(id);
  }
  function handle(p, m) {
    if (!live(p)) return;
    const time = now();
    // Bound all operations (including refresh); an excessive burst has no effects.
    let bucket = rate.get(p.id);
    if (!bucket || time - bucket.at >= 1000) { bucket = { at: time, count: 0 }; rate.set(p.id, bucket); }
    if (++bucket.count > 8) return;
    expire();
    let group = membership.get(p.id);
    if (m.op === 'get') return state(p.id);
    if (m.op === 'create') {
      if (group) return state(p.id);
      group = { id: nextId++, leader: p.id, members: new Set([p.id]) };
      membership.set(p.id, group);
      clearInvites(id => id === p.id);
      return state(p.id);
    }
    if (m.op === 'leave') return remove(p.id);
    if (m.op === 'decline') {
      const invite = invitations.get(p.id);
      if (!invite || m.from !== invite.from) return error(p, 'Convite indisponível.');
      invitations.delete(p.id);
      emit(invite.from, { op: 'notice', message: 'Convite recusado.' });
      return state(p.id);
    }
    if (m.op === 'accept') {
      const invite = invitations.get(p.id);
      if (!invite || m.from !== invite.from) return error(p, 'O convite expirou ou foi cancelado.');
      const invitedGroup = membership.get(invite.from);
      if (group || !invitedGroup || invitedGroup.id !== invite.group || invitedGroup.leader !== invite.from) {
        invitations.delete(p.id); state(p.id);
        return error(p, 'Este convite não está mais disponível.');
      }
      if (invitedGroup.members.size >= LIMIT) return error(p, 'A party está cheia.');
      invitations.delete(p.id);
      invitedGroup.members.add(p.id); membership.set(p.id, invitedGroup);
      return broadcast(invitedGroup);
    }
    if ((!group && m.op !== 'invite') || (group && group.leader !== p.id)) return error(p, 'Somente o líder pode fazer isso.');
    const target = Number.isSafeInteger(m.id) ? players.get(m.id) : null;
    if (!live(target) || target.id === p.id) return error(p, 'Jogador indisponível.');
    if (m.op === 'invite') {
      if (target.hid || p.hid) return error(p, 'Jogador indisponível.');
      if (group && group.members.size >= LIMIT) return error(p, 'A party está cheia.');
      if (membership.has(target.id)) return error(p, 'Esse jogador já está em uma party.');
      if (invitations.has(target.id)) return error(p, 'Esse jogador já tem um convite pendente.');
      // Profile invites create a group only after every target/permission check succeeds.
      if (!group) {
        group = { id: nextId++, leader: p.id, members: new Set([p.id]) };
        membership.set(p.id, group);
        clearInvites(id => id === p.id);
      }
      invitations.set(target.id, { from: p.id, group: group.id, until: time + TTL });
      state(p.id);
      state(target.id);
      return emit(p.id, { op: 'notice', message: 'Convite enviado. Válido por 60 segundos.' });
    }
    if (!group.members.has(target.id)) return error(p, 'Esse jogador não pertence à sua party.');
    if (m.op === 'kick') return remove(target.id);
    if (m.op === 'promote') {
      group.leader = target.id;
      clearInvites((id, invite) => invite.group === group.id);
      return broadcast(group);
    }
    error(p, 'Ação inválida.');
  }
  return { handle, tick: expire, disconnect(id) { remove(id); rate.delete(id); } };
};

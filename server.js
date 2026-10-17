import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import * as mediasoup from 'mediasoup';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const listenIp = process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1';
const announcedAddress = process.env.MEDIASOUP_ANNOUNCED_ADDRESS;
const rtcMinPort = Number(process.env.MEDIASOUP_MIN_PORT || 40000);
const rtcMaxPort = Number(process.env.MEDIASOUP_MAX_PORT || 40100);
const rooms = new Map();
const peers = new Map();
const db = new DatabaseSync(process.env.CANOPY_DATABASE_PATH || path.join(root, 'yapper.sqlite'));
let worker;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    pronouns TEXT NOT NULL DEFAULT '',
    about_me TEXT NOT NULL DEFAULT '',
    avatar_data TEXT NOT NULL DEFAULT '',
    banner_data TEXT NOT NULL DEFAULT '',
    profile_theme TEXT NOT NULL DEFAULT 'midnight',
    primary_color TEXT NOT NULL DEFAULT '#263743',
    accent_color TEXT NOT NULL DEFAULT '#2eb9b4',
    avatar_decoration TEXT NOT NULL DEFAULT 'None',
    avatar_frame TEXT NOT NULL DEFAULT 'None',
    profile_links TEXT NOT NULL DEFAULT '[]',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    about TEXT NOT NULL,
    focus TEXT NOT NULL,
    visibility TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS server_invites (
    token TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    private_channel INTEGER NOT NULL DEFAULT 0,
    text_only INTEGER NOT NULL DEFAULT 0,
    read_only INTEGER NOT NULL DEFAULT 0,
    slowmode_seconds INTEGER NOT NULL DEFAULT 0,
    allowed_roles_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(server_id,name)
  );
  CREATE TABLE IF NOT EXISTS server_roles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3989ff',
    permissions_json TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE(server_id,name)
  );
  CREATE TABLE IF NOT EXISTS server_default_permissions (
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    permissions_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS server_emojis (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    image_data TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE(server_id,name)
  );
  CREATE TABLE IF NOT EXISTS server_bans (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(server_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS server_timeouts (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(server_id,user_id)
  );
  CREATE TABLE IF NOT EXISTS server_reports (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    handled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS server_tickets (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL DEFAULT 'general',
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_attachments (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    image_base64 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_server_sent ON messages(server_id, sent_at);
`);
if (db.prepare('PRAGMA index_list(server_tickets)').all().some(index => index.origin === 'u')) {
  db.exec(`BEGIN;
    ALTER TABLE server_tickets RENAME TO server_tickets_old;
    CREATE TABLE server_tickets (id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
    INSERT INTO server_tickets(id,server_id,user_id,title,details,status,created_at) SELECT id,server_id,user_id,title,details,status,created_at FROM server_tickets_old;
    DROP TABLE server_tickets_old;
    COMMIT;`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS server_tickets_one_open ON server_tickets(server_id,user_id) WHERE status='open'");
db.exec(`CREATE TABLE IF NOT EXISTS server_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES server_tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL
)`);
const serverColumns = [
  ['icon_data', "TEXT NOT NULL DEFAULT ''"], ['banner_data', "TEXT NOT NULL DEFAULT ''"],
  ['tag', "TEXT NOT NULL DEFAULT ''"], ['invite_slug', "TEXT NOT NULL DEFAULT ''"],
  ['discovery_enabled', 'INTEGER NOT NULL DEFAULT 1'], ['tickets_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['raid_protection_until', 'INTEGER NOT NULL DEFAULT 0'], ['featured_until', 'INTEGER NOT NULL DEFAULT 0']
];
const serverColumnNames = new Set(db.prepare('PRAGMA table_info(servers)').all().map(column => column.name));
for (const [name, definition] of serverColumns) if (!serverColumnNames.has(name)) db.exec(`ALTER TABLE servers ADD COLUMN ${name} ${definition}`);
if (!db.prepare('PRAGMA table_info(memberships)').all().some(column => column.name === 'role_id')) db.exec('ALTER TABLE memberships ADD COLUMN role_id TEXT');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS servers_invite_slug_unique ON servers(invite_slug COLLATE NOCASE) WHERE invite_slug <> ''");
const starterChannels = [['general','text','A public place to talk.'],['introductions','text','Say hello and meet your community.'],['events','text','Plan meetups and share events.'],['networking','text','Meet collaborators and share what you are working on.'],['Meetup lounge','voice','']];
for (const existingServer of db.prepare('SELECT id FROM servers').all()) {
  for (const [position,[name,type,topic]] of starterChannels.entries()) db.prepare('INSERT OR IGNORE INTO server_channels(id,server_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), existingServer.id, name, type, topic, position, new Date().toISOString());
  const currentOwner = db.prepare('SELECT owner_user_id AS ownerUserId FROM servers WHERE id=?').get(existingServer.id)?.ownerUserId;
  if (!currentOwner) {
    const firstMember = db.prepare('SELECT user_id AS userId FROM memberships WHERE server_id=? ORDER BY joined_at LIMIT 1').get(existingServer.id);
    if (firstMember) { db.prepare('UPDATE servers SET owner_user_id=? WHERE id=? AND owner_user_id IS NULL').run(firstMember.userId, existingServer.id); db.prepare("UPDATE memberships SET role='owner' WHERE server_id=? AND user_id=?").run(existingServer.id, firstMember.userId); }
  }
}
if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'channel')) db.exec("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'general'");
for (const [column, definition] of [['locked','INTEGER NOT NULL DEFAULT 0'],['private_channel','INTEGER NOT NULL DEFAULT 0'],['text_only','INTEGER NOT NULL DEFAULT 0'],['read_only','INTEGER NOT NULL DEFAULT 0'],['slowmode_seconds','INTEGER NOT NULL DEFAULT 0'],['allowed_roles_json',"TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!db.prepare('PRAGMA table_info(server_channels)').all().some(existing => existing.name === column)) db.exec(`ALTER TABLE server_channels ADD COLUMN ${column} ${definition}`);
}
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
const profileColumns = [
  ['pronouns', "TEXT NOT NULL DEFAULT ''"], ['about_me', "TEXT NOT NULL DEFAULT ''"],
  ['avatar_data', "TEXT NOT NULL DEFAULT ''"], ['banner_data', "TEXT NOT NULL DEFAULT ''"],
  ['profile_theme', "TEXT NOT NULL DEFAULT 'midnight'"], ['primary_color', "TEXT NOT NULL DEFAULT '#263743'"],
  ['accent_color', "TEXT NOT NULL DEFAULT '#2eb9b4'"], ['avatar_decoration', "TEXT NOT NULL DEFAULT 'None'"],
  ['avatar_frame', "TEXT NOT NULL DEFAULT 'None'"], ['profile_links', "TEXT NOT NULL DEFAULT '[]'"]
];
db.exec(`CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS creator_badges (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,badge_id TEXT NOT NULL,granted_by TEXT NOT NULL REFERENCES users(id),granted_at TEXT NOT NULL,PRIMARY KEY(user_id,badge_id));`);
const BADGE_CATALOG = [
  { id: 'verified', label: 'Verified', icon: '✓' },
  { id: 'moderator', label: 'Moderator', icon: '✓' },
  { id: 'plus', label: 'PLUS', icon: '' },
  { id: 'bug-hunter', label: 'Bug Hunter', icon: '🐛' }
];
const badgeById = new Map(BADGE_CATALOG.map(badge => [badge.id, badge]));
const initialCreator = db.prepare("SELECT id FROM users WHERE username='mor' COLLATE NOCASE").get();
if (initialCreator && !db.prepare("SELECT 1 FROM app_metadata WHERE key='creator_user_id'").get()) {
  db.prepare("INSERT INTO app_metadata(key,value) VALUES('creator_user_id',?)").run(initialCreator.id);
}
function creatorUserId() { return db.prepare("SELECT value FROM app_metadata WHERE key='creator_user_id'").get()?.value || ''; }
function isCreator(userId) { return !!userId && creatorUserId() === userId; }
function badgesForUser(userId) {
  return db.prepare('SELECT badge_id AS id FROM creator_badges WHERE user_id=? ORDER BY granted_at,badge_id').all(userId)
    .map(row => badgeById.get(row.id)).filter(Boolean);
}
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
for (const [name, definition] of profileColumns) if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email COLLATE NOCASE) WHERE email <> ''");
db.prepare(`INSERT OR IGNORE INTO servers(id,name,about,focus,visibility,owner_user_id,created_at)
  VALUES('yapper-commons','Canopy Commons','A public place to meet people, share ideas, and find your next meetup.','Meetups & networking','Public',NULL,?)`).run(new Date().toISOString());
db.prepare("UPDATE servers SET name='Canopy Commons' WHERE id='yapper-commons' AND name='Yapper Commons'").run();

const hashToken = token => createHash('sha256').update(token).digest('hex');
function accountForToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name AS displayName
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token), Date.now());
  return row || null;
}
function accountForRequest(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; }));
  return accountForToken(cookies.yapper_session);
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_500_000) throw new Error('Request is too large.'); }
  return JSON.parse(raw || '{}');
}
function setSession(res, req, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, expires);
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('set-cookie', `yapper_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}
const userView = user => ({ id: user.id, username: user.username, displayName: user.displayName, isCreator: isCreator(user.id), badges: badgesForUser(user.id) });
function profileForUser(userId) {
  const row = db.prepare(`SELECT username,email,display_name AS displayName,pronouns,about_me AS aboutMe,
    avatar_data AS avatarData,banner_data AS bannerData,profile_theme AS theme,
    primary_color AS primaryColor,accent_color AS accentColor,
    avatar_decoration AS decoration,avatar_frame AS frame,profile_links AS links
    FROM users WHERE id=?`).get(userId);
  try { row.links = JSON.parse(row.links); } catch { row.links = []; }
  row.id = userId; row.isCreator = isCreator(userId); row.badges = badgesForUser(userId);
  return row;
}
function serverAccess(serverId, userId) {
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  const membership = db.prepare('SELECT role,role_id AS roleId FROM memberships WHERE server_id=? AND user_id=?').get(serverId, userId);
  if (!server || !membership) return null;
  let permissions = [];
  if (membership.roleId) {
    const role = db.prepare('SELECT permissions_json AS permissions FROM server_roles WHERE id=? AND server_id=?').get(membership.roleId, serverId);
    try { permissions = role ? JSON.parse(role.permissions) : []; } catch { permissions = []; }
  } else {
    const defaults = db.prepare('SELECT permissions_json AS permissions FROM server_default_permissions WHERE server_id=?').get(serverId);
    try { permissions = defaults ? JSON.parse(defaults.permissions) : []; } catch { permissions = []; }
  }
  const owner = server.owner_user_id === userId || membership.role === 'owner';
  const moderatorBadge = badgesForUser(userId).some(badge => badge.id === 'moderator');
  const badgePermissions = ['reviewReports','timeoutMembers','banMembers'];
  return { server, membership, owner, moderatorBadge, permissions, can: permission => owner || (moderatorBadge && badgePermissions.includes(permission)) || permissions.includes('*') || permissions.includes(permission) };
}
function activeServerTimeout(serverId, userId) {
  const timeout = db.prepare('SELECT expires_at AS expiresAt FROM server_timeouts WHERE server_id=? AND user_id=?').get(serverId, userId);
  if (timeout && timeout.expiresAt <= Date.now()) { db.prepare('DELETE FROM server_timeouts WHERE server_id=? AND user_id=?').run(serverId, userId); return null; }
  return timeout || null;
}
function channelAllowedRoles(channel) {
  try { const roles = JSON.parse(channel.allowed_roles_json || '[]'); return Array.isArray(roles) ? roles : []; } catch { return []; }
}
function canSeeChannel(channel, access) {
  if (!access) return false;
  if (access.can('manageChannels')) return true;
  const allowedRoles = channelAllowedRoles(channel);
  return !channel.private_channel || (!!access.membership?.roleId && allowedRoles.includes(access.membership.roleId));
}
function canPostChannel(channel, access) {
  if (!access) return false;
  if (access.can('manageChannels')) return true;
  if (channel.locked) return false;
  if (!channel.read_only) return true;
  return !!access.membership?.roleId && channelAllowedRoles(channel).includes(access.membership.roleId);
}
function channelView(channel, access) {
  return { ...channel, locked: !!channel.locked, privateChannel: !!channel.private_channel, textOnly: !!channel.text_only,
    readOnly: !!channel.read_only, slowmodeSeconds: channel.slowmode_seconds || 0, allowedRoles: channelAllowedRoles(channel),
    canPost: canPostChannel(channel, access), canUpload: !channel.text_only || !!access?.can('manageChannels') };
}
function serverSettingsView(serverId) {
  const server = db.prepare(`SELECT id,name,about,focus,visibility,icon_data AS iconData,banner_data AS bannerData,tag,invite_slug AS inviteSlug,
    discovery_enabled AS discoveryEnabled,tickets_enabled AS ticketsEnabled,raid_protection_until AS raidProtectionUntil,featured_until AS featuredUntil,
    (SELECT COUNT(*) FROM memberships m WHERE m.server_id=servers.id) AS memberCount FROM servers WHERE id=?`).get(serverId);
  if (!server) return null;
  return { ...server, onlineCount: [...rooms.values()].filter(room => room.serverId === serverId).reduce((count, room) => count + room.peers.size, 0), channels: db.prepare('SELECT * FROM server_channels WHERE server_id=? ORDER BY position,name').all(serverId) };
}

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, parameters: { useinbandfec: 1, usedtx: 1 } },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {} }
];

function send(ws, packet) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet));
}

function notifyRoom(room, packet, exceptPeerId) {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptPeerId) send(peer.ws, { event: packet.event, data: packet.data });
  }
}

function publicPeer(peer) {
  const profile = profileForUser(peer.user.id);
  return { id: peer.id, accountId: peer.user.id, username: peer.user.username, name: profile.displayName, displayName: profile.displayName, role: peer.role, avatarData: profile.avatarData, bannerData: profile.bannerData, decoration: profile.decoration, frame: profile.frame, pronouns: profile.pronouns, aboutMe: profile.aboutMe, primaryColor: profile.primaryColor, accentColor: profile.accentColor };
}

async function getRoom(serverId, channel) {
  const id = `${serverId}|${channel}`;
  if (!rooms.has(id)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(id, { id, serverId, channel, router, peers: new Map() });
  }
  return rooms.get(id);
}

function getPeer(ws) {
  const peer = peers.get(ws);
  if (!peer) throw new Error('Join a server before sending this request.');
  return peer;
}

function roomTransport(peer, transportId) {
  const transport = peer.transports.get(transportId);
  if (!transport) throw new Error('WebRTC transport not found.');
  return transport;
}

async function leaveRoom(peer) {
  if (!peer?.room) return;
  const room = peer.room;
  for (const consumer of peer.consumers.values()) consumer.close();
  for (const producer of peer.producers.values()) producer.close();
  for (const transport of peer.transports.values()) transport.close();
  peer.consumers.clear(); peer.producers.clear(); peer.transports.clear();
  room.peers.delete(peer.id);
  peer.room = null;
  notifyRoom(room, { event: 'peerLeft', data: { peerId: peer.id } });
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.id);
  }
}

async function createTransport(room) {
  const infos = ['udp', 'tcp'].map(protocol => ({
    protocol,
    ip: listenIp,
    ...(announcedAddress ? { announcedAddress } : {})
  }));
  return room.router.createWebRtcTransport({
    listenInfos: infos,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
    minimumAvailableOutgoingBitrate: 600_000,
    appData: {}
  });
}

async function request(ws, method, data) {
  if (method === 'joinRoom') {
    const peer = getPeer(ws);
    const serverId = String(data.roomId || '').slice(0, 80);
    const channel = String(data.channel || 'general');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(serverId) || channel.length > 50) throw new Error('Invalid server or channel.');
    const serverRecord = db.prepare('SELECT id,raid_protection_until AS raidProtectionUntil FROM servers WHERE id=?').get(serverId);
    if (!serverRecord) throw new Error('Community not found.');
    const channelInfo = db.prepare('SELECT * FROM server_channels WHERE server_id=? AND name=? COLLATE NOCASE').get(serverId, channel);
    if (!channelInfo) throw new Error('That channel no longer exists.');
    if (db.prepare('SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?').get(serverId, peer.user.id)) throw new Error('You are banned from this community.');
    if (serverRecord.raidProtectionUntil > Date.now() && !db.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=? AND role='owner'").get(serverId, peer.user.id)) throw new Error('This community is temporarily locked for raid protection.');
    const membership = db.prepare("SELECT m.role,CASE WHEN m.role='owner' THEN 'owner' ELSE COALESCE(r.name,m.role) END AS displayRole,r.color AS roleColor,m.role_id AS roleId FROM memberships m LEFT JOIN server_roles r ON r.id=m.role_id WHERE m.server_id=? AND m.user_id=?").get(serverId, peer.user.id);
    if (!membership) throw new Error('Join this community before connecting.');
    if (!canSeeChannel(channelInfo, serverAccess(serverId, peer.user.id))) throw new Error('You need an allowed role to view this channel.');
    await leaveRoom(peer);
    const room = await getRoom(serverId, channel);
    peer.room = room;
    peer.role = membership.displayRole;
    room.peers.set(peer.id, peer);
    notifyRoom(room, { event: 'peerJoined', data: publicPeer(peer) }, peer.id);
    const members = db.prepare(`SELECT u.id,u.username,u.display_name AS displayName,u.pronouns,u.about_me AS aboutMe,u.avatar_data AS avatarData,u.banner_data AS bannerData,
      u.primary_color AS primaryColor,u.accent_color AS accentColor,u.avatar_decoration AS decoration,u.avatar_frame AS frame,u.profile_links AS links,m.joined_at AS joinedAt,
      (SELECT COUNT(*) FROM memberships mine JOIN memberships theirs ON theirs.server_id=mine.server_id WHERE mine.user_id=? AND theirs.user_id=u.id) AS mutualServerCount,
      CASE WHEN m.role='owner' THEN 'owner' ELSE COALESCE(r.name,m.role) END AS role,m.role_id AS roleId,r.name AS customRoleName,r.color AS roleColor
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN server_roles r ON r.id=m.role_id WHERE m.server_id=? ORDER BY m.joined_at`).all(peer.user.id,serverId)
      .map(member => { try { member.links=JSON.parse(member.links||'[]'); } catch { member.links=[]; } return { ...member, badges: badgesForUser(member.id), online: [...room.peers.values()].some(other => other.user.id === member.id) }; });
    const history = db.prepare(`SELECT m.id,m.user_id AS userId,u.username,u.display_name AS userName,CASE WHEN member.role='owner' THEN 'owner' ELSE COALESCE(r.name,member.role) END AS role,m.text,m.sent_at AS sentAt
      FROM messages m JOIN users u ON u.id=m.user_id JOIN memberships member ON member.user_id=m.user_id AND member.server_id=m.server_id LEFT JOIN server_roles r ON r.id=member.role_id
      WHERE m.server_id=? AND m.channel=? ORDER BY m.sent_at DESC LIMIT 100`).all(serverId, channel)
      .reverse().map(message => ({ ...message, badges: badgesForUser(message.userId), peerId: message.userId }));
    return {
      peerId: peer.id,
      roomId: serverId,
      channel,
      routerRtpCapabilities: room.router.rtpCapabilities,
      peers: [...room.peers.values()].filter(other => other.id !== peer.id).map(publicPeer),
      producers: [...room.peers.values()].filter(other => other.id !== peer.id).flatMap(other => [...other.producers.values()].map(producer => ({ producerId: producer.id, peerId: other.id, kind: producer.kind, appData: producer.appData }))),
      members,
      messages: history
    };
  }

  if (method === 'sendMessage') {
    const peer = getPeer(ws), room = peer.room;
    const text = String(data.text || '').trim();
    if (!text || text.length > 2000) throw new Error('Messages must be between 1 and 2000 characters.');
    const mediaIds = [...text.matchAll(/\[\[media:([a-f0-9-]{36})\]\]/gi)].map(match => match[1]);
    if (mediaIds.length > 4) throw new Error('A message can contain up to 4 images or GIFs.');
    for (const attachmentId of mediaIds) {
      if (!db.prepare('SELECT 1 FROM message_attachments WHERE id=? AND server_id=? AND uploaded_by=?').get(attachmentId, room.serverId, peer.user.id)) throw new Error('That upload is missing or does not belong to you.');
    }
    const channelInfo = db.prepare('SELECT * FROM server_channels WHERE server_id=? AND name=?').get(room.serverId, room.channel);
    if (channelInfo?.type === 'voice') throw new Error('Text messages are disabled in voice channels.');
    const access = serverAccess(room.serverId, peer.user.id);
    if (activeServerTimeout(room.serverId, peer.user.id)) throw new Error('You are timed out in this community and cannot send messages yet.');
    if (!canPostChannel(channelInfo, access)) throw new Error('You need an allowed role to post in this channel.');
    if (channelInfo?.text_only && mediaIds.length && !access?.can('manageChannels')) throw new Error('Images and GIFs are disabled in this text-only channel.');
    const lastMessage = db.prepare('SELECT sent_at AS sentAt FROM messages WHERE server_id=? AND channel=? AND user_id=? ORDER BY sent_at DESC LIMIT 1').get(room.serverId, room.channel, peer.user.id);
    const waitMs = (channelInfo?.slowmode_seconds || 0) * 1000 - (Date.now() - Date.parse(lastMessage?.sentAt || 0));
    if (waitMs > 0 && !access?.can('manageChannels')) throw new Error(`Slowmode is on. Please wait ${Math.ceil(waitMs / 1000)} seconds.`);
    const lock = db.prepare('SELECT raid_protection_until FROM servers WHERE id=?').get(room.serverId)?.raid_protection_until || 0;
    if (lock > Date.now() && !db.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=? AND role='owner'").get(room.serverId, peer.user.id)) throw new Error('This community is temporarily locked for raid protection.');
    const message = { id: randomUUID(), peerId: peer.id, userId: peer.user.id, userName: peer.user.displayName, username: peer.user.username, role: peer.role, badges: badgesForUser(peer.user.id), text, sentAt: new Date().toISOString() };
    db.prepare('INSERT INTO messages(id,server_id,user_id,channel,text,sent_at) VALUES(?,?,?,?,?,?)').run(message.id, room.serverId, peer.user.id, room.channel, text, message.sentAt);
    notifyRoom(room, { event: 'chatMessage', data: message });
    return { messageId: message.id };
  }

  const peer = getPeer(ws), room = peer.room;
  if (!room) throw new Error('Join a server first.');

  switch (method) {
    case 'getRouterRtpCapabilities': return room.router.rtpCapabilities;
    case 'createWebRtcTransport': {
      const transport = await createTransport(room);
      peer.transports.set(transport.id, transport);
      transport.observer.on('close', () => peer.transports.delete(transport.id));
      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      };
    }
    case 'connectTransport': {
      const transport = roomTransport(peer, data.transportId);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      return { connected: true };
    }
    case 'produce': {
      if (activeServerTimeout(room.serverId, peer.user.id)) throw new Error('You are timed out in this community and cannot speak yet.');
      const transport = roomTransport(peer, data.transportId);
      const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters, appData: data.appData || {} });
      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => peer.producers.delete(producer.id));
      notifyRoom(room, { event: 'newProducer', data: { producerId: producer.id, peerId: peer.id, kind: producer.kind, appData: producer.appData } }, peer.id);
      return { id: producer.id };
    }
    case 'consume': {
      const transport = roomTransport(peer, data.transportId);
      if (!room.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) throw new Error('This browser cannot receive that media format.');
      const consumer = await transport.consume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        const producerOwner = [...room.peers.values()].find(other => other.producers.has(data.producerId));
        send(peer.ws, { event: 'producerClosed', data: { consumerId: consumer.id, producerId: data.producerId, peerId: producerOwner?.id } });
      });
      return { id: consumer.id, producerId: data.producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, type: consumer.type, producerPaused: consumer.producerPaused, appData: consumer.appData };
    }
    case 'resumeConsumer': {
      const consumer = peer.consumers.get(data.consumerId);
      if (!consumer) throw new Error('Consumer not found.');
      await consumer.resume();
      return { resumed: true };
    }
    case 'closeProducer': {
      const producer = peer.producers.get(data.producerId);
      if (producer) { producer.close(); peer.producers.delete(producer.id); }
      return { closed: true };
    }
    default: throw new Error(`Unknown request: ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (pathname.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/me') {
        const user = accountForRequest(req);
        return user ? json(res, 200, { user: userView(user) }) : json(res, 401, { error: 'Sign in required.' });
      }
      if (req.method === 'POST' && pathname === '/api/register') {
        const data = await bodyJson(req);
        const email = String(data.email || '').trim().toLowerCase();
        const password = String(data.password || '');
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email address.' });
        if (password.length < 10 || password.length > 128) return json(res, 400, { error: 'Password must be 10–128 characters.' });
        const localPart = email.slice(0, email.indexOf('@'));
        const displayName = localPart.trim().length >= 2 ? localPart.trim().slice(0, 32) : 'New member';
        const username = `member_${randomBytes(5).toString('hex')}`;
        const user = { id: randomUUID(), username, displayName };
        const salt = randomBytes(16);
        const passwordHash = scryptSync(password, salt, 64);
        try {
          db.prepare('INSERT INTO users(id,username,email,display_name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, username, email, displayName, salt.toString('hex'), passwordHash.toString('hex'), new Date().toISOString());
          db.prepare('INSERT OR IGNORE INTO memberships(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run('yapper-commons', user.id, 'member', new Date().toISOString());
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'An account already uses that email address.' });
          throw error;
        }
        setSession(res, req, user.id);
        return json(res, 201, { user });
      }
      if (req.method === 'POST' && pathname === '/api/login') {
        const data = await bodyJson(req);
        const identifier = String(data.email || data.identifier || data.username || '').trim();
        const password = String(data.password || '');
        const row = db.prepare('SELECT id,username,display_name AS displayName,password_salt,password_hash FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE').get(identifier, identifier);
        if (!row || password.length > 128) return json(res, 401, { error: 'Username or password is incorrect.' });
        const attempted = scryptSync(password, Buffer.from(row.password_salt, 'hex'), 64);
        if (!timingSafeEqual(attempted, Buffer.from(row.password_hash, 'hex'))) return json(res, 401, { error: 'Username or password is incorrect.' });
        db.prepare('INSERT OR IGNORE INTO memberships(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run('yapper-commons', row.id, 'member', new Date().toISOString());
        setSession(res, req, row.id);
        return json(res, 200, { user: userView(row) });
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; }));
        if (cookies.yapper_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookies.yapper_session));
        return json(res, 200, { ok: true }, { 'set-cookie': 'yapper_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      }
      const user = accountForRequest(req);
      if (!user) return json(res, 401, { error: 'Sign in required.' });
      if (req.method === 'PATCH' && pathname === '/api/account') {
        const data = await bodyJson(req);
        const username = String(data.username || '').trim();
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
          return json(res, 400, { error: 'Username must be 3–24 characters and use only letters, numbers, or underscores.' });
        }
        const existing = db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?').get(username, user.id);
        if (existing) return json(res, 409, { error: 'That username is already taken.' });
        db.prepare('UPDATE users SET username=? WHERE id=?').run(username, user.id);
        if (username.toLowerCase() === 'mor' && !creatorUserId()) db.prepare("INSERT OR IGNORE INTO app_metadata(key,value) VALUES('creator_user_id',?)").run(user.id);
        return json(res, 200, { profile: profileForUser(user.id) });
      }
      if (req.method === 'GET' && pathname === '/api/creator/badges') {
        if (!isCreator(user.id)) return json(res, 403, { error: 'Only the creator can manage account badges.' });
        return json(res, 200, { badges: BADGE_CATALOG });
      }
      const creatorBadgeMatch = pathname.match(/^\/api\/creator\/users\/([a-f0-9-]+)\/badges$/i);
      if (req.method === 'PATCH' && creatorBadgeMatch) {
        if (!isCreator(user.id)) return json(res, 403, { error: 'Only the creator can manage account badges.' });
        const targetId = creatorBadgeMatch[1];
        if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId)) return json(res, 404, { error: 'Account not found.' });
        const data = await bodyJson(req);
        if (!Array.isArray(data.badges)) return json(res, 400, { error: 'Choose a list of badges.' });
        const chosen = [...new Set(data.badges.map(id => String(id)))];
        if (chosen.some(id => !badgeById.has(id))) return json(res, 400, { error: 'One or more badges are not available.' });
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM creator_badges WHERE user_id=?').run(targetId);
          const insert = db.prepare('INSERT INTO creator_badges(user_id,badge_id,granted_by,granted_at) VALUES(?,?,?,?)');
          const now = new Date().toISOString();
          for (const id of chosen) insert.run(targetId, id, user.id, now);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { badges: badgesForUser(targetId) });
      }
      if (req.method === 'GET' && pathname === '/api/profile') return json(res, 200, { profile: profileForUser(user.id) });
      if (req.method === 'PATCH' && pathname === '/api/profile') {
        const data = await bodyJson(req);
        const displayName = String(data.displayName || '').trim().slice(0, 32);
        const pronouns = String(data.pronouns || '').trim().slice(0, 32);
        const aboutMe = String(data.aboutMe || '').trim().slice(0, 120);
        const theme = String(data.theme || 'midnight').slice(0, 24);
        const primaryColor = String(data.primaryColor || '#263743');
        const accentColor = String(data.accentColor || '#2eb9b4');
        const decoration = String(data.decoration || 'None');
        const frame = String(data.frame || 'None');
        const avatarData = String(data.avatarData || '');
        const bannerData = String(data.bannerData || '');
        if (displayName.length < 2) return json(res, 400, { error: 'Display name must be at least 2 characters.' });
        if (!/^#[0-9a-f]{6}$/i.test(primaryColor) || !/^#[0-9a-f]{6}$/i.test(accentColor)) return json(res, 400, { error: 'Choose valid profile colors.' });
        const imagePattern = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
        if (avatarData && (avatarData.length > 1_500_000 || !imagePattern.test(avatarData))) return json(res, 400, { error: 'Avatar images must be PNG, JPEG, WebP, or GIF under 1 MB.' });
        if (bannerData && (bannerData.length > 3_000_000 || !imagePattern.test(bannerData))) return json(res, 400, { error: 'Banner images must be PNG, JPEG, WebP, or GIF under 2 MB.' });
        const decorations = ['None','Aurora','Blue Flame','Chromatic','Eclipse','Ember','Frost','Galaxy','Gold','Hearts','Ice','Nebula','Neon','Obsidian','Ocean','Pearl','Prism','Rainbow','Royal','Sparkle','Toxic','Flames','Crown','Halo','Horns','Cat ears','Wings','Headphones'];
        const frames = ['None','Rainbow','Fire','Ice','Gold','Sparkle','Galaxy','Neon','Hearts','Toxic'];
        if (!decorations.includes(decoration) || !frames.includes(frame)) return json(res, 400, { error: 'Choose a listed avatar decoration and frame.' });
        const links = Array.isArray(data.links) ? data.links.slice(0, 5).map(link => {
          const url = new URL(String(link.url || ''));
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Profile links must use HTTP or HTTPS.');
          return { label: String(link.label || url.hostname).trim().slice(0, 32), url: url.href.slice(0, 2048) };
        }) : [];
        db.prepare(`UPDATE users SET display_name=?,pronouns=?,about_me=?,avatar_data=?,banner_data=?,profile_theme=?,
          primary_color=?,accent_color=?,avatar_decoration=?,avatar_frame=?,profile_links=? WHERE id=?`).run(
          displayName, pronouns, aboutMe, avatarData, bannerData, theme, primaryColor, accentColor,
          decoration, frame, JSON.stringify(links), user.id
        );
        return json(res, 200, { profile: profileForUser(user.id) });
      }
      if (req.method === 'GET' && pathname === '/api/servers') {
        const rows = db.prepare(`SELECT s.id,s.name,s.about,s.focus,s.visibility,s.icon_data AS iconData,s.banner_data AS bannerData,s.tag,s.owner_user_id AS ownerUserId,
          EXISTS(SELECT 1 FROM memberships mine WHERE mine.server_id=s.id AND mine.user_id=?) AS joined,
          (SELECT COUNT(*) FROM memberships members WHERE members.server_id=s.id) AS memberCount
          FROM servers s WHERE (s.visibility='Public' AND s.discovery_enabled=1) OR EXISTS(SELECT 1 FROM memberships mine WHERE mine.server_id=s.id AND mine.user_id=?) ORDER BY (s.featured_until > ?) DESC,s.created_at`).all(user.id, user.id, Date.now());
        return json(res, 200, { servers: rows.map(row => ({ ...row, onlineCount: [...rooms.values()].filter(room => room.serverId === row.id).reduce((sum, room) => sum + room.peers.size, 0) })) });
      }
      if (req.method === 'POST' && pathname === '/api/servers') {
        const data = await bodyJson(req);
        const name = String(data.name || '').trim().slice(0, 42);
        const about = String(data.about || '').trim().slice(0, 180);
        const focus = String(data.focus || 'Meetups & events').slice(0, 40);
        const visibility = data.visibility === 'Invite only' ? 'Invite only' : 'Public';
        if (name.length < 3) return json(res, 400, { error: 'Server name must contain at least 3 characters.' });
        const id = randomUUID();
        const now = new Date().toISOString();
        const savedAbout = about || 'A place for people to meet, share ideas, and make connections.';
        const inviteCode = visibility === 'Invite only' ? randomBytes(12).toString('hex') : null;
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO servers(id,name,about,focus,visibility,owner_user_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id, name, savedAbout, focus, visibility, user.id, now);
          db.prepare('INSERT INTO memberships(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(id, user.id, 'owner', now);
          for (const [channelName, type, topic, position] of [['general','text','Start a conversation with your community.',0],['introductions','text','Say hello and meet your community.',1],['events','text','Plan meetups and share events.',2],['networking','text','Meet collaborators and share what you are working on.',3],['Meetup lounge','voice','',4]]) db.prepare('INSERT INTO server_channels(id,server_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, channelName, type, topic, position, now);
          if (inviteCode) db.prepare('INSERT INTO server_invites(token,server_id,created_by,created_at) VALUES(?,?,?,?)').run(inviteCode, id, user.id, now);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return json(res, 201, { server: { id, name, about: savedAbout, focus, visibility, ownerUserId: user.id, joined: 1, memberCount: 1, onlineCount: 0 }, inviteCode });
      }
      const serverSettingsMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/settings$/i);
      if (serverSettingsMatch) {
        const serverId = serverSettingsMatch[1], access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community to view its settings.' });
        if (req.method === 'GET') return json(res, 200, { settings: serverSettingsView(serverId) });
        if (req.method === 'PATCH') {
          if (!access.can('manageServer')) return json(res, 403, { error: 'Only server owners or members with Manage Server permission can edit these settings.' });
          const data = await bodyJson(req);
          const name = String(data.name || '').trim().slice(0, 42);
          const about = String(data.about || '').trim().slice(0, 180);
          const focus = String(data.focus || 'Meetups & events').trim().slice(0, 40);
          const visibility = data.visibility === 'Invite only' ? 'Invite only' : 'Public';
          const iconData = String(data.iconData || ''), bannerData = String(data.bannerData || '');
          const tag = String(data.tag || '').trim().toUpperCase();
          const inviteSlug = String(data.inviteSlug || '').trim().toLowerCase();
          const discoveryEnabled = data.discoveryEnabled === false ? 0 : 1;
          const ticketsEnabled = data.ticketsEnabled === true ? 1 : 0;
          const imagePattern = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
          if (name.length < 3) return json(res, 400, { error: 'Server name must contain at least 3 characters.' });
          if (tag && !/^[A-Z0-9]{2,4}$/.test(tag)) return json(res, 400, { error: 'Server tags must be 2–4 letters or numbers.' });
          if (inviteSlug && !/^[a-z0-9-]{3,24}$/.test(inviteSlug)) return json(res, 400, { error: 'Invite links must be 3–24 letters, numbers, or hyphens.' });
          if (inviteSlug && access.server.invite_slug !== inviteSlug && serverSettingsView(serverId).memberCount < 5) return json(res, 400, { error: 'Custom invite links unlock when your community has 5 members.' });
          if (iconData && (iconData.length > 1_500_000 || !imagePattern.test(iconData))) return json(res, 400, { error: 'Server icons must be PNG, JPEG, WebP, or GIF under 1 MB.' });
          if (bannerData && (bannerData.length > 3_000_000 || !imagePattern.test(bannerData))) return json(res, 400, { error: 'Server banners must be PNG, JPEG, WebP, or GIF under 2 MB.' });
          const slugUsed = inviteSlug && db.prepare('SELECT id FROM servers WHERE invite_slug=? COLLATE NOCASE AND id<>?').get(inviteSlug, serverId);
          if (slugUsed) return json(res, 409, { error: 'That custom invite link is already in use.' });
          if (access.server.invite_slug && access.server.invite_slug !== inviteSlug) db.prepare('DELETE FROM server_invites WHERE server_id=? AND token=?').run(serverId, access.server.invite_slug);
          db.prepare(`UPDATE servers SET name=?,about=?,focus=?,visibility=?,icon_data=?,banner_data=?,tag=?,invite_slug=?,discovery_enabled=?,tickets_enabled=? WHERE id=?`).run(
            name, about, focus, visibility, iconData, bannerData, tag, inviteSlug, discoveryEnabled, ticketsEnabled, serverId
          );
          if (inviteSlug) db.prepare('INSERT OR IGNORE INTO server_invites(token,server_id,created_by,created_at) VALUES(?,?,?,?)').run(inviteSlug, serverId, user.id, new Date().toISOString());
          if (visibility === 'Invite only') db.prepare('UPDATE servers SET discovery_enabled=0 WHERE id=?').run(serverId);
          return json(res, 200, { settings: serverSettingsView(serverId) });
        }
      }
      const serverDeleteMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)$/i);
      if (req.method === 'DELETE' && serverDeleteMatch) {
        const access = serverAccess(serverDeleteMatch[1], user.id);
        if (!access) return json(res, 404, { error: 'Community not found.' });
        if (!access.owner) return json(res, 403, { error: 'Only the community owner can delete this server.' });
        if (serverDeleteMatch[1] === 'yapper-commons') return json(res, 400, { error: 'Canopy Commons is the built-in community and cannot be deleted.' });
        db.prepare('DELETE FROM servers WHERE id=?').run(serverDeleteMatch[1]);
        return json(res, 200, { deleted: true });
      }
      const serverLeaveMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/leave$/i);
      if (req.method === 'POST' && serverLeaveMatch) {
        const serverId = serverLeaveMatch[1], access = serverAccess(serverId, user.id);
        if (!access) return json(res, 404, { error: 'Community not found.' });
        if (access.owner) return json(res, 400, { error: 'Transfer ownership before leaving your community.' });
        db.prepare('DELETE FROM memberships WHERE server_id=? AND user_id=?').run(serverId, user.id);
        for (const peer of peers.values()) if (peer.user.id === user.id && peer.room?.serverId === serverId) await leaveRoom(peer);
        return json(res, 200, { left: true });
      }
      const channelsMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/channels$/i);
      if (channelsMatch) {
        const serverId = channelsMatch[1], access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community to view its channels.' });
        if (req.method === 'GET') {
          const timeout=activeServerTimeout(serverId,user.id), timeoutExpiresAt=timeout?.expiresAt||0;
          const visible=serverSettingsView(serverId).channels.filter(channel => canSeeChannel(channel, access)).map(channel => {const view=channelView(channel,access);return {...view,canPost:view.canPost&&!timeout,canUpload:view.canUpload&&!timeout,timedOutUntil:timeoutExpiresAt}});
          return json(res, 200, { channels: visible, canManage: access.can('manageChannels') });
        }
        if (req.method === 'POST') {
          if (!access.can('manageChannels')) return json(res, 403, { error: 'You need Manage Channels permission.' });
          const data = await bodyJson(req), name = String(data.name || '').trim().toLowerCase().replace(/\s+/g, '-'), type = data.type === 'voice' ? 'voice' : 'text';
          if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return json(res, 400, { error: 'Channel names must be 2–40 letters, numbers, or hyphens.' });
          const duplicate = db.prepare('SELECT 1 FROM server_channels WHERE server_id=? AND name=? COLLATE NOCASE').get(serverId, name);
          if (duplicate) return json(res, 409, { error: 'A channel with that name already exists.' });
          const channel = { id: randomUUID(), name, type, topic: String(data.topic || '').trim().slice(0, 120), position: serverSettingsView(serverId).channels.length };
          db.prepare('INSERT INTO server_channels(id,server_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?)').run(channel.id, serverId, channel.name, channel.type, channel.topic, channel.position, new Date().toISOString());
          return json(res, 201, { channel });
        }
      }
      const channelMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/channels\/([a-z0-9_-]+)$/i);
      if (channelMatch) {
        const [, serverId, channelId] = channelMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community to manage its channels.' });
        if (!access.can('manageChannels')) return json(res, 403, { error: 'You need Manage Channels permission.' });
        const channel = db.prepare('SELECT * FROM server_channels WHERE id=? AND server_id=?').get(channelId, serverId);
        if (!channel) return json(res, 404, { error: 'Channel not found.' });
        if (req.method === 'PATCH') {
          const data = await bodyJson(req);
          const name = String(data.name ?? channel.name).trim().toLowerCase().replace(/\s+/g, '-');
          if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return json(res, 400, { error: 'Channel names must be 2–40 letters, numbers, or hyphens.' });
          if (name !== channel.name && db.prepare('SELECT 1 FROM server_channels WHERE server_id=? AND name=? COLLATE NOCASE').get(serverId, name)) return json(res, 409, { error: 'A channel with that name already exists.' });
          const allowedRoles = Array.isArray(data.allowedRoles) ? [...new Set(data.allowedRoles.map(String))] : channelAllowedRoles(channel);
          const validRoles = new Set(db.prepare('SELECT id FROM server_roles WHERE server_id=?').all(serverId).map(role => role.id));
          if (allowedRoles.some(roleId => !validRoles.has(roleId))) return json(res, 400, { error: 'Choose roles from this community.' });
          const slowmodeSeconds = data.slowmodeSeconds === undefined ? channel.slowmode_seconds : Number(data.slowmodeSeconds);
          if (![0,5,10,15,30,60,120,300,600].includes(slowmodeSeconds)) return json(res, 400, { error: 'Choose a supported slowmode duration.' });
          const privateChannel = data.privateChannel === undefined ? !!channel.private_channel : !!data.privateChannel;
          const textOnly = data.textOnly === undefined ? !!channel.text_only : !!data.textOnly;
          const readOnly = data.readOnly === undefined ? !!channel.read_only : !!data.readOnly;
          db.prepare('UPDATE server_channels SET name=?,topic=?,private_channel=?,text_only=?,read_only=?,slowmode_seconds=?,allowed_roles_json=?,locked=0 WHERE id=? AND server_id=?')
            .run(name, String(data.topic ?? channel.topic ?? '').trim().slice(0, 120), privateChannel ? 1 : 0, textOnly ? 1 : 0, readOnly ? 1 : 0, slowmodeSeconds, JSON.stringify(allowedRoles), channelId, serverId);
          db.prepare('UPDATE messages SET channel=? WHERE server_id=? AND channel=?').run(name, serverId, channel.name);
          return json(res, 200, { channel: channelView(db.prepare('SELECT * FROM server_channels WHERE id=?').get(channelId), access) });
        }
        if (req.method === 'DELETE') {
          if (channel.name === 'general') return json(res, 400, { error: 'The general channel is required and cannot be deleted.' });
          db.prepare('DELETE FROM messages WHERE server_id=? AND channel=?').run(serverId, channel.name);
          db.prepare('DELETE FROM server_channels WHERE id=?').run(channelId);
          return json(res, 200, { deleted: true });
        }
      }
      const raidMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/raid$/i);
      if (req.method === 'POST' && raidMatch) {
        const access = serverAccess(raidMatch[1], user.id);
        if (!access?.can('manageServer')) return json(res, 403, { error: 'You need Manage Server permission.' });
        const data = await bodyJson(req), minutes = Number(data.minutes);
        if (![0, 15, 60, 1440].includes(minutes)) return json(res, 400, { error: 'Choose 15 minutes, 1 hour, 1 day, or unlock.' });
        const until = minutes ? Date.now() + minutes * 60_000 : 0;
        db.prepare('UPDATE servers SET raid_protection_until=? WHERE id=?').run(until, raidMatch[1]);
        return json(res, 200, { raidProtectionUntil: until });
      }
      const featureMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/feature$/i);
      if (req.method === 'POST' && featureMatch) {
        const access = serverAccess(featureMatch[1], user.id);
        if (!access?.can('manageServer')) return json(res, 403, { error: 'You need Manage Server permission.' });
        const server = access.server;
        if (server.visibility !== 'Public') return json(res, 400, { error: 'Only public communities can be featured.' });
        const until = Date.now() + 7 * 24 * 60 * 60_000;
        db.prepare('UPDATE servers SET featured_until=?,discovery_enabled=1 WHERE id=?').run(until, featureMatch[1]);
        return json(res, 200, { featuredUntil: until });
      }
      const ticketsMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/tickets(?:\/([a-z0-9_-]+))?$/i);
      if (ticketsMatch) {
        const [, serverId, ticketId] = ticketsMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community first.' });
        if (req.method === 'POST' && !ticketId) {
          if (!access.server.tickets_enabled) return json(res, 403, { error: 'Private support tickets are disabled in this community.' });
          const data = await bodyJson(req), title = String(data.title || '').trim().slice(0, 100), details = String(data.details || '').trim().slice(0, 1200);
          if (title.length < 3) return json(res, 400, { error: 'Ticket titles must have at least 3 characters.' });
          const existing = db.prepare("SELECT id FROM server_tickets WHERE server_id=? AND user_id=? AND status='open'").get(serverId, user.id);
          if (existing) return json(res, 409, { error: 'You already have an open ticket in this community.' });
          const ticket = { id: randomUUID(), title, details };
          db.prepare('INSERT INTO server_tickets(id,server_id,user_id,title,details,created_at) VALUES(?,?,?,?,?,?)').run(ticket.id, serverId, user.id, title, details, new Date().toISOString());
          return json(res, 201, { ticket });
        }
        if (req.method === 'GET' && ticketId === 'mine') {
          const ticket=db.prepare("SELECT id,title,details,status,created_at AS createdAt FROM server_tickets WHERE server_id=? AND user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(serverId,user.id);
          return json(res,200,{ticket:ticket||null});
        }
        if (req.method === 'GET') {
          if (!access.can('manageServer')) return json(res, 403, { error: 'You need Manage Server permission.' });
          return json(res, 200, { tickets: db.prepare('SELECT t.id,t.user_id AS userId,u.username,t.title,t.details,t.status,t.created_at AS createdAt FROM server_tickets t JOIN users u ON u.id=t.user_id WHERE t.server_id=? ORDER BY t.created_at DESC').all(serverId) });
        }
        if (req.method === 'PATCH' && ticketId) {
          if (!access.can('manageServer')) return json(res, 403, { error: 'You need Manage Server permission.' });
          db.prepare("UPDATE server_tickets SET status='closed' WHERE id=? AND server_id=?").run(ticketId, serverId); return json(res, 200, { closed: true });
        }
      }
      const ticketMessagesMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/tickets\/([a-z0-9_-]+)\/messages$/i);
      if (ticketMessagesMatch) {
        const [,serverId,ticketId]=ticketMessagesMatch,access=serverAccess(serverId,user.id);
        if(!access)return json(res,403,{error:'Join this community first.'});
        const ticket=db.prepare('SELECT id,user_id AS userId,status FROM server_tickets WHERE id=? AND server_id=?').get(ticketId,serverId);
        if(!ticket)return json(res,404,{error:'Support ticket not found.'});
        if(ticket.userId!==user.id&&!access.can('manageServer'))return json(res,403,{error:'Only the ticket author and community moderators can read this conversation.'});
        if(req.method==='GET')return json(res,200,{messages:db.prepare('SELECT tm.id,tm.user_id AS userId,u.display_name AS displayName,tm.text,tm.sent_at AS sentAt FROM server_ticket_messages tm JOIN users u ON u.id=tm.user_id WHERE tm.ticket_id=? ORDER BY tm.sent_at').all(ticketId)});
        if(req.method==='POST'){
          if(ticket.status!=='open')return json(res,400,{error:'This ticket is closed.'});
          const data=await bodyJson(req),text=String(data.text||'').trim();
          if(!text||text.length>2000)return json(res,400,{error:'Replies must be between 1 and 2000 characters.'});
          const message={id:randomUUID(),userId:user.id,text,sentAt:new Date().toISOString()};
          db.prepare('INSERT INTO server_ticket_messages(id,ticket_id,user_id,text,sent_at) VALUES(?,?,?,?,?)').run(message.id,ticketId,user.id,text,message.sentAt);
          return json(res,201,{message});
        }
      }
      const rolesMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/roles$/i);
      if (rolesMatch) {
        const [, serverId] = rolesMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community to view its roles.' });
        if (req.method === 'GET') return json(res, 200, { canManage: access.can('manageRoles'), canGrantModeration: access.owner, roles: db.prepare('SELECT id,name,color,permissions_json AS permissionsJson,position FROM server_roles WHERE server_id=? ORDER BY position,name').all(serverId).map(role => ({ ...role, permissions: JSON.parse(role.permissionsJson) })) });
        if (req.method === 'POST') {
          if (!access.can('manageRoles')) return json(res, 403, { error: 'You need Manage Roles permission.' });
          const data = await bodyJson(req), name = String(data.name || '').trim().slice(0, 32), color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#3989ff';
          if (name.length < 2) return json(res, 400, { error: 'Role names must contain at least 2 characters.' });
          if (db.prepare('SELECT 1 FROM server_roles WHERE server_id=? AND name=? COLLATE NOCASE').get(serverId, name)) return json(res, 409, { error: 'A role with that name already exists.' });
          const role = { id: randomUUID(), name, color, permissions: [] };
          db.prepare('INSERT INTO server_roles(id,server_id,name,color,permissions_json,position) VALUES(?,?,?,?,?,?)').run(role.id, serverId, name, color, '[]', db.prepare('SELECT COUNT(*) AS n FROM server_roles WHERE server_id=?').get(serverId).n);
          return json(res, 201, { role });
        }
      }
      const defaultPermissionsMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/default-permissions$/i);
      if (defaultPermissionsMatch) {
        const [, serverId] = defaultPermissionsMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community first.' });
        if (req.method === 'GET') {
          const row = db.prepare('SELECT permissions_json AS permissions FROM server_default_permissions WHERE server_id=?').get(serverId);
          let permissions=[];try{permissions=JSON.parse(row?.permissions||'[]')}catch{}
          return json(res, 200, { permissions });
        }
        if (req.method === 'PUT') {
          if (!access.can('manageRoles')) return json(res, 403, { error: 'You need Manage Roles permission.' });
          const data = await bodyJson(req), allowed=['manageServer','manageChannels','manageRoles','manageEmoji','createInvite','kickMembers'];
          const permissions=Array.isArray(data.permissions)?data.permissions.filter(item=>allowed.includes(item)):[];
          db.prepare('INSERT INTO server_default_permissions(server_id,permissions_json) VALUES(?,?) ON CONFLICT(server_id) DO UPDATE SET permissions_json=excluded.permissions_json').run(serverId,JSON.stringify(permissions));
          return json(res,200,{permissions});
        }
      }
      const roleMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/roles\/([a-z0-9_-]+)$/i);
      if (roleMatch) {
        const [, serverId, roleId] = roleMatch, access = serverAccess(serverId, user.id);
        if (!access?.can('manageRoles')) return json(res, 403, { error: 'You need Manage Roles permission.' });
        if (req.method === 'DELETE') { db.prepare('UPDATE memberships SET role_id=NULL WHERE server_id=? AND role_id=?').run(serverId, roleId); db.prepare('DELETE FROM server_roles WHERE id=? AND server_id=?').run(roleId, serverId); return json(res, 200, { deleted: true }); }
        if (req.method === 'PATCH') {
          const data = await bodyJson(req), moderationPermissions=['reviewReports','timeoutMembers','banMembers'];
          const allowed=['manageServer','manageChannels','manageRoles','manageEmoji','createInvite','kickMembers',...moderationPermissions];
          let permissions=Array.isArray(data.permissions)?data.permissions.filter(item=>allowed.includes(item)):[];
          if(!access.owner){const existing=db.prepare('SELECT permissions_json AS permissions FROM server_roles WHERE id=? AND server_id=?').get(roleId,serverId);let previous=[];try{previous=JSON.parse(existing?.permissions||'[]')}catch{};permissions=[...permissions.filter(item=>!moderationPermissions.includes(item)),...previous.filter(item=>moderationPermissions.includes(item))]}
          const name = String(data.name || '').trim().slice(0, 32), color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#3989ff';
          if (name.length < 2) return json(res, 400, { error: 'Role names must contain at least 2 characters.' });
          db.prepare('UPDATE server_roles SET name=?,color=?,permissions_json=? WHERE id=? AND server_id=?').run(name, color, JSON.stringify(permissions), roleId, serverId);
          return json(res, 200, { saved: true });
        }
      }
      const memberActionMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/members\/([a-z0-9_-]+)$/i);
      if (memberActionMatch && req.method === 'PATCH') {
        const [, serverId, memberId] = memberActionMatch, access = serverAccess(serverId, user.id);
        if (!access?.can('manageRoles')) return json(res, 403, { error: 'You need Manage Roles permission.' });
        const data = await bodyJson(req), roleId = String(data.roleId || '');
        const role = roleId ? db.prepare('SELECT id FROM server_roles WHERE id=? AND server_id=?').get(roleId, serverId) : null;
        if (roleId && !role) return json(res, 404, { error: 'Role not found.' });
        const currentMembership=db.prepare('SELECT role_id AS roleId FROM memberships WHERE server_id=? AND user_id=?').get(serverId,memberId);
        if (!currentMembership) return json(res,404,{error:'Community member not found.'});
        if (!access.owner) {
          const moderationPermissions=['reviewReports','timeoutMembers','banMembers'];
          const hasModerationRole=roleIds=>roleIds?.some(id=>{const assignedRole=db.prepare('SELECT permissions_json AS permissions FROM server_roles WHERE id=? AND server_id=?').get(id,serverId);let permissions=[];try{permissions=JSON.parse(assignedRole?.permissions||'[]')}catch{};return permissions.some(permission=>moderationPermissions.includes(permission))})||false;
          if(hasModerationRole([roleId,currentMembership.roleId]))return json(res,403,{error:'Only the server owner can change moderator assignments.'});
        }
        db.prepare('UPDATE memberships SET role_id=? WHERE server_id=? AND user_id=?').run(role?.id||null,serverId,memberId);
        const assigned=db.prepare("SELECT CASE WHEN m.role='owner' THEN 'owner' ELSE COALESCE(r.name,m.role) END AS displayRole FROM memberships m LEFT JOIN server_roles r ON r.id=m.role_id WHERE m.server_id=? AND m.user_id=?").get(serverId,memberId);
        for(const peer of peers.values())if(peer.user.id===memberId&&peer.room?.serverId===serverId)peer.role=assigned.displayRole;
        return json(res, 200, { saved: true });
      }
      if (memberActionMatch && req.method === 'DELETE') {
        const [, serverId, memberId] = memberActionMatch, access = serverAccess(serverId, user.id);
        const data = await bodyJson(req), ban = data.ban === true;
        if (!access?.can(ban ? 'banMembers' : 'kickMembers')) return json(res, 403, { error: `You need ${ban ? 'Ban' : 'Kick'} Members permission.` });
        if (memberId === access.server.owner_user_id || memberId === user.id) return json(res, 400, { error: 'You cannot remove this community owner or yourself.' });
        if (ban) { db.prepare('INSERT OR REPLACE INTO server_bans(server_id,user_id,reason,created_by,created_at) VALUES(?,?,?,?,?)').run(serverId, memberId, String(data.reason || '').trim().slice(0, 240), user.id, new Date().toISOString()); db.prepare('DELETE FROM server_timeouts WHERE server_id=? AND user_id=?').run(serverId,memberId); }
        db.prepare('DELETE FROM memberships WHERE server_id=? AND user_id=?').run(serverId, memberId);
        for (const peer of peers.values()) if (peer.user.id === memberId && peer.room?.serverId === serverId) { await leaveRoom(peer); }
        return json(res, 200, { removed: true, banned: ban });
      }
      const bansMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/bans(?:\/([a-z0-9_-]+))?$/i);
      if (bansMatch) {
        const [, serverId, bannedId] = bansMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community first.' });
        if (req.method === 'GET') {
          if (!access.can('banMembers')) return json(res, 403, { error: 'You need Ban Members permission.' });
          return json(res, 200, { bans: db.prepare('SELECT b.user_id AS userId,u.username,u.display_name AS displayName,b.reason,b.created_at AS createdAt FROM server_bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=? ORDER BY b.created_at DESC').all(serverId) });
        }
        if (req.method === 'DELETE' && bannedId) {
          if (!access.can('banMembers')) return json(res, 403, { error: 'You need Ban Members permission.' });
          db.prepare('DELETE FROM server_bans WHERE server_id=? AND user_id=?').run(serverId, bannedId); return json(res, 200, { unbanned: true });
        }
      }
      const emojiMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/emojis(?:\/([a-z0-9_-]+))?$/i);
      if (emojiMatch) {
        const [, serverId, emojiId] = emojiMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community first.' });
        if (req.method === 'GET') return json(res, 200, { emojis: db.prepare('SELECT id,name,image_data AS imageData FROM server_emojis WHERE server_id=? ORDER BY name').all(serverId) });
        if (!access.can('manageEmoji')) return json(res, 403, { error: 'You need Manage Emoji permission.' });
        if (req.method === 'POST' && !emojiId) {
          const data = await bodyJson(req), name = String(data.name || '').trim().replace(/[^a-z0-9_]/gi, '_').slice(0, 32), imageData = String(data.imageData || '');
          if (!name) return json(res, 400, { error: 'Give the emoji a name.' });
          if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageData) || imageData.length > 300_000) return json(res, 400, { error: 'Emoji image must be PNG, JPEG, WebP, or GIF under 200 KB.' });
          if (db.prepare('SELECT COUNT(*) AS n FROM server_emojis WHERE server_id=?').get(serverId).n >= 50) return json(res, 400, { error: 'This community has reached the 50 emoji limit.' });
          const emoji = { id: randomUUID(), name, imageData };
          try { db.prepare('INSERT INTO server_emojis(id,server_id,name,image_data,created_by,created_at) VALUES(?,?,?,?,?,?)').run(emoji.id, serverId, name, imageData, user.id, new Date().toISOString()); } catch { return json(res, 409, { error: 'That emoji name is already used.' }); }
          return json(res, 201, { emoji });
        }
        if (req.method === 'DELETE' && emojiId) { db.prepare('DELETE FROM server_emojis WHERE id=? AND server_id=?').run(emojiId, serverId); return json(res, 200, { deleted: true }); }
      }
      if (req.method === 'GET' && pathname === '/api/tenor/search') {
        const query = new URL(req.url, `http://${req.headers.host}`).searchParams.get('q')?.trim().slice(0, 80) || '';
        if (!query) return json(res, 200, { results: [] });
        if (!process.env.TENOR_API_KEY) return json(res, 503, { error: 'Tenor search needs an existing Tenor API key. Set TENOR_API_KEY in the environment and restart Canopy.' });
        const params = new URLSearchParams({ q: query, key: process.env.TENOR_API_KEY, client_key: 'canopy_community_chat', limit: '16', media_filter: 'tinygif,gif', contentfilter: 'medium' });
        const tenorResponse = await fetch(`https://tenor.googleapis.com/v2/search?${params}`, { signal: AbortSignal.timeout(9000) });
        if (!tenorResponse.ok) return json(res, 502, { error: 'Tenor could not return GIF results right now.' });
        const payload = await tenorResponse.json();
        const results = (payload.results || []).map(item => ({ id: String(item.id || ''), title: String(item.content_description || 'GIF').slice(0, 100), previewUrl: item.media_formats?.tinygif?.url, gifUrl: item.media_formats?.gif?.url })).filter(item => item.previewUrl && item.gifUrl && item.id);
        return json(res, 200, { results });
      }
      const attachmentMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/attachments(?:\/([a-f0-9-]{36}|tenor))?$/i);
      if (attachmentMatch) {
        const [, serverId, attachmentId] = attachmentMatch;
        if (!serverAccess(serverId, user.id)) return json(res, 403, { error: 'Join this community to share or view its images.' });
        if (req.method === 'GET' && attachmentId && attachmentId !== 'tenor') {
          const attachment = db.prepare('SELECT mime_type AS mimeType,image_base64 AS imageBase64 FROM message_attachments WHERE id=? AND server_id=?').get(attachmentId, serverId);
          if (!attachment) return json(res, 404, { error: 'Image not found.' });
          const bytes = Buffer.from(attachment.imageBase64, 'base64');
          res.writeHead(200, { 'content-type': attachment.mimeType, 'content-length': bytes.length, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
          return res.end(bytes);
        }
        if (req.method === 'POST' && (!attachmentId || attachmentId === 'tenor')) {
          const access = serverAccess(serverId, user.id);
          if (activeServerTimeout(serverId,user.id)) return json(res,403,{error:'You are timed out in this community and cannot upload media yet.'});
          const activeRoom = [...rooms.values()].find(room => room.serverId === serverId && [...room.peers.values()].some(peer => peer.user.id === user.id));
          const channelInfo = activeRoom && db.prepare('SELECT * FROM server_channels WHERE server_id=? AND name=?').get(serverId, activeRoom.channel);
          if (!channelInfo || !canSeeChannel(channelInfo, access)) return json(res, 403, { error: 'Join a channel where you can share media first.' });
          if (channelInfo.type === 'voice') return json(res, 400, { error: 'Media uploads are disabled in voice channels.' });
          if (!canPostChannel(channelInfo, access)) return json(res, 403, { error: 'You do not have permission to post in this channel.' });
          if (channelInfo.text_only && !access?.can('manageChannels')) return json(res, 403, { error: 'Images and GIFs are disabled in this text-only channel.' });
          const data = await bodyJson(req), now = new Date().toISOString();
          let mimeType, imageBase64;
          if (attachmentId === 'tenor') {
            let gifUrl;
            try { gifUrl = new URL(String(data.url || '')); } catch { return json(res, 400, { error: 'Choose a valid Tenor GIF.' }); }
            if (gifUrl.protocol !== 'https:' || gifUrl.hostname !== 'media.tenor.com') return json(res, 400, { error: 'Choose a GIF from Tenor.' });
            const gifResponse = await fetch(gifUrl.href, { redirect: 'error', signal: AbortSignal.timeout(10000) });
            mimeType = gifResponse.headers.get('content-type')?.split(';')[0].toLowerCase();
            if (!gifResponse.ok || mimeType !== 'image/gif') return json(res, 400, { error: 'Tenor did not return a GIF image.' });
            const bytes = Buffer.from(await gifResponse.arrayBuffer());
            if (bytes.length > 2_500_000) return json(res, 413, { error: 'That GIF is over the 2.5 MB upload limit. Choose a smaller one.' });
            imageBase64 = bytes.toString('base64');
          } else {
            const imageData = String(data.imageData || ''), match = imageData.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i);
            if (!match || imageData.length > 3_400_000) return json(res, 400, { error: 'Upload a PNG, JPEG, WebP, or GIF image under 2.5 MB.' });
            mimeType = match[1].toLowerCase(); imageBase64 = match[2];
          }
          const id = randomUUID();
          db.prepare('INSERT INTO message_attachments(id,server_id,uploaded_by,mime_type,image_base64,created_at) VALUES(?,?,?,?,?,?)').run(id, serverId, user.id, mimeType, imageBase64, now);
          return json(res, 201, { attachment: { id, mimeType } });
        }
      }
      const moderationAccessMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/moderation-access$/i);
      if (req.method === 'GET' && moderationAccessMatch) {
        const access=serverAccess(moderationAccessMatch[1],user.id);
        if(!access)return json(res,403,{error:'Join this community first.'});
        return json(res,200,{owner:access.owner,canReviewReports:access.can('reviewReports'),canTimeout:access.can('timeoutMembers'),canBan:access.can('banMembers')});
      }
      const reportsMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/reports(?:\/([a-z0-9_-]+))?$/i);
      if (reportsMatch) {
        const [, serverId, reportId] = reportsMatch, access = serverAccess(serverId, user.id);
        if (!access) return json(res, 403, { error: 'Join this community first.' });
        if (req.method === 'POST' && !reportId) {
          const data = await bodyJson(req), messageId = String(data.messageId || ''), reason = String(data.reason || '').trim().slice(0, 240);
          const message = db.prepare('SELECT user_id AS userId FROM messages WHERE id=? AND server_id=?').get(messageId, serverId);
          if (!message) return json(res, 404, { error: 'Message not found.' });
          if (message.userId === user.id) return json(res, 400, { error: 'You cannot report your own message.' });
          if (reason.length < 3) return json(res, 400, { error: 'Please describe the concern.' });
          const reportId = randomUUID();
          db.prepare('INSERT INTO server_reports(id,server_id,message_id,reported_user_id,reporter_user_id,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(reportId, serverId, messageId, message.userId, user.id, reason, new Date().toISOString());
          return json(res, 201, { submitted: true, reportId });
        }
        if (req.method === 'GET') {
          if (!access.can('reviewReports')) return json(res, 403, { error: 'You need the Review Reports role permission.' });
          return json(res, 200, { canBan: access.can('banMembers'), canTimeout: access.can('timeoutMembers'), canReview: true, canManageTickets:access.can('manageServer'),
            reports: db.prepare(`SELECT r.id,r.message_id AS messageId,r.reported_user_id AS reportedUserId,r.reason,r.status,r.created_at AS createdAt,reporter.username AS reporter,reported.username AS reportedUser,m.text AS message,
              (SELECT t.expires_at FROM server_timeouts t WHERE t.server_id=r.server_id AND t.user_id=r.reported_user_id AND t.expires_at>?) AS timeoutExpiresAt
              FROM server_reports r JOIN users reporter ON reporter.id=r.reporter_user_id LEFT JOIN users reported ON reported.id=r.reported_user_id LEFT JOIN messages m ON m.id=r.message_id WHERE r.server_id=? ORDER BY r.created_at DESC`).all(Date.now(),serverId) });
        }
        if (req.method === 'PATCH' && reportId) {
          if (!access.can('reviewReports')) return json(res, 403, { error: 'You need the Review Reports role permission.' });
          const data = await bodyJson(req), report = db.prepare('SELECT reported_user_id AS reportedUserId,reason,status FROM server_reports WHERE id=? AND server_id=?').get(reportId,serverId);
          if (!report) return json(res,404,{error:'Report not found.'});
          if(report.status!=='open')return json(res,409,{error:'This report has already been handled.'});
          const now = new Date().toISOString(), action = String(data.action||'');
          if (action === 'ban') {
            if (!access.can('banMembers')) return json(res,403,{error:'You need the Ban Members role permission.'});
            if (!report.reportedUserId) return json(res,400,{error:'The reported account is no longer available.'});
            if (report.reportedUserId===user.id||report.reportedUserId===access.server.owner_user_id) return json(res,400,{error:'You cannot ban yourself or the community owner.'});
            db.prepare('INSERT OR REPLACE INTO server_bans(server_id,user_id,reason,created_by,created_at) VALUES(?,?,?,?,?)').run(serverId,report.reportedUserId,String(data.reason||report.reason).trim().slice(0,240),user.id,now);
            db.prepare('DELETE FROM server_timeouts WHERE server_id=? AND user_id=?').run(serverId,report.reportedUserId);
            db.prepare('DELETE FROM memberships WHERE server_id=? AND user_id=?').run(serverId,report.reportedUserId);
            for(const peer of peers.values())if(peer.user.id===report.reportedUserId&&peer.room?.serverId===serverId)await leaveRoom(peer);
          } else if (action === 'timeout') {
            if (!access.can('timeoutMembers')) return json(res,403,{error:'You need the Timeout Members role permission.'});
            const durationMinutes=Number(data.durationMinutes);
            if (!report.reportedUserId) return json(res,400,{error:'The reported account is no longer available.'});
            if (report.reportedUserId===user.id||report.reportedUserId===access.server.owner_user_id) return json(res,400,{error:'You cannot time out yourself or the community owner.'});
            if (!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>40320) return json(res,400,{error:'Timeouts can last from 1 minute to 28 days.'});
            const expiresAt=Date.now()+durationMinutes*60_000;
            db.prepare('INSERT INTO server_timeouts(server_id,user_id,reason,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET reason=excluded.reason,expires_at=excluded.expires_at,created_by=excluded.created_by,created_at=excluded.created_at').run(serverId,report.reportedUserId,String(data.reason||report.reason).trim().slice(0,240),expiresAt,user.id,now);
            for(const peer of peers.values())if(peer.user.id===report.reportedUserId&&peer.room?.serverId===serverId)for(const producer of peer.producers.values()){producer.close();peer.producers.delete(producer.id)}
          } else if (!['handled','dismissed'].includes(data.status)) return json(res,400,{error:'Choose ban, timeout, handle, or dismiss.'});
          const status=action==='dismiss'?'dismissed':action==='handle'?'handled':action?'handled':data.status;
          db.prepare('UPDATE server_reports SET status=?,handled_by=?,handled_at=? WHERE id=? AND server_id=?').run(status,user.id,now,reportId,serverId);
          return json(res,200,{saved:true,action});
        }
      }
      const serverInviteMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/invite$/i);
      if (req.method === 'POST' && serverInviteMatch) {
        const membership = db.prepare('SELECT 1 FROM memberships WHERE server_id=? AND user_id=?').get(serverInviteMatch[1], user.id);
        if (!membership) return json(res, 403, { error: 'Join this community before inviting people.' });
        let invite = db.prepare('SELECT token FROM server_invites WHERE server_id=? ORDER BY (token=(SELECT invite_slug FROM servers WHERE id=?)) DESC,created_at LIMIT 1').get(serverInviteMatch[1], serverInviteMatch[1]);
        if (!invite) {
          const token = randomBytes(12).toString('hex');
          db.prepare('INSERT INTO server_invites(token,server_id,created_by,created_at) VALUES(?,?,?,?)').run(token, serverInviteMatch[1], user.id, new Date().toISOString());
          invite = { token };
        }
        return json(res, 200, { inviteCode: invite.token });
      }
      const inviteJoinMatch = pathname.match(/^\/api\/invites\/([a-z0-9-]{3,24})\/join$/i);
      if (req.method === 'POST' && inviteJoinMatch) {
        const invite = db.prepare(`SELECT s.id,s.visibility FROM server_invites i JOIN servers s ON s.id=i.server_id WHERE i.token=?`).get(inviteJoinMatch[1].toLowerCase());
        if (!invite) return json(res, 404, { error: 'Invite code not found.' });
        if (db.prepare('SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?').get(invite.id, user.id)) return json(res, 403, { error: 'You are banned from this community.' });
        if ((db.prepare('SELECT raid_protection_until FROM servers WHERE id=?').get(invite.id)?.raid_protection_until || 0) > Date.now()) return json(res, 423, { error: 'This community is temporarily locked for raid protection.' });
        db.prepare('INSERT OR IGNORE INTO memberships(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(invite.id, user.id, 'member', new Date().toISOString());
        return json(res, 200, { joined: true, serverId: invite.id });
      }
      const joinMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/join$/i);
      if (req.method === 'POST' && joinMatch) {
        const found = db.prepare('SELECT id,visibility,raid_protection_until AS raidProtectionUntil FROM servers WHERE id=?').get(joinMatch[1]);
        if (!found) return json(res, 404, { error: 'Community not found.' });
        if (found.visibility !== 'Public') return json(res, 403, { error: 'This community is invite-only.' });
        if (found.raidProtectionUntil > Date.now()) return json(res, 423, { error: 'This community is temporarily locked for raid protection.' });
        if (db.prepare('SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?').get(found.id, user.id)) return json(res, 403, { error: 'You are banned from this community.' });
        db.prepare('INSERT OR IGNORE INTO memberships(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(found.id, user.id, 'member', new Date().toISOString());
        return json(res, 200, { joined: true });
      }
      const membersMatch = pathname.match(/^\/api\/servers\/([a-z0-9_-]+)\/members$/i);
      if (req.method === 'GET' && membersMatch) {
        const membership = db.prepare('SELECT 1 FROM memberships WHERE server_id=? AND user_id=?').get(membersMatch[1], user.id);
        if (!membership) return json(res, 403, { error: 'Join this community to view its members.' });
        const members = db.prepare(`SELECT u.id,u.username,u.display_name AS displayName,u.pronouns,u.about_me AS aboutMe,u.avatar_data AS avatarData,u.banner_data AS bannerData,
          u.primary_color AS primaryColor,u.accent_color AS accentColor,u.avatar_decoration AS decoration,u.avatar_frame AS frame,u.profile_links AS links,m.joined_at AS joinedAt,
          (SELECT COUNT(*) FROM memberships mine JOIN memberships theirs ON theirs.server_id=mine.server_id WHERE mine.user_id=? AND theirs.user_id=u.id) AS mutualServerCount,
          CASE WHEN m.role='owner' THEN 'owner' ELSE COALESCE(r.name,m.role) END AS role,m.role_id AS roleId,r.name AS customRoleName,r.color AS roleColor
          FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN server_roles r ON r.id=m.role_id WHERE m.server_id=? ORDER BY m.joined_at`).all(user.id,membersMatch[1]);
        return json(res, 200, { members: members.map(m => { try { m.links=JSON.parse(m.links||'[]'); } catch { m.links=[]; } return { ...m, badges: badgesForUser(m.id), online: [...rooms.values()].filter(room => room.serverId === membersMatch[1]).some(room => [...room.peers.values()].some(peer => peer.user.id === m.id)) }; }) });
      }
      return json(res, 404, { error: 'API route not found.' });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' });
    }
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: peers.size }));
    return;
  }
  if (pathname === '/assets/realtime-client.js') {
    try {
      const body = await readFile(path.join(root, 'assets', 'realtime-client.js'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Client bundle missing. Run npm start to build it.');
    }
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const body = await readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(500); res.end('Unable to load the app.');
    }
    return;
  }
  const invitePage = pathname.match(/^\/invite\/([a-z0-9-]{3,24})$/i);
  if (invitePage) {
    res.writeHead(302, { location: `/?invite=${encodeURIComponent(invitePage[1].toLowerCase())}`, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const user = accountForRequest(req);
  if (!user) {
    send(ws, { event: 'authRequired', data: {} });
    ws.close(4401, 'Sign in required.');
    return;
  }
  const peer = { id: randomUUID(), user, role: 'member', ws, room: null, transports: new Map(), producers: new Map(), consumers: new Map() };
  peers.set(ws, peer);
  ws.on('message', async raw => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return send(ws, { id: null, error: 'Invalid JSON.' }); }
    if (!packet || typeof packet.id !== 'string' || typeof packet.method !== 'string') return;
    try {
      const result = await request(ws, packet.method, packet.data || {});
      send(ws, { id: packet.id, result });
    } catch (error) {
      send(ws, { id: packet.id, error: error instanceof Error ? error.message : 'Request failed.' });
    }
  });
  ws.on('close', async () => { await leaveRoom(peer); peers.delete(ws); });
  ws.on('error', error => console.error('WebSocket error:', error.message));
});

async function start() {
  worker = await mediasoup.createWorker({
    rtcMinPort,
    rtcMaxPort,
    logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
    logTags: ['ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  });
  worker.on('died', error => { console.error('mediasoup worker died:', error); process.exit(1); });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Canopy signaling and SFU server listening on http://localhost:${port}`);
    console.log(`mediasoup ICE: ${listenIp}:${rtcMinPort}-${rtcMaxPort}${announcedAddress ? ` (announced ${announcedAddress})` : ''}`);
    if (listenIp === '127.0.0.1') console.log('Local-only media networking. Set MEDIASOUP_LISTEN_IP and MEDIASOUP_ANNOUNCED_ADDRESS for remote clients.');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  for (const peer of peers.values()) await leaveRoom(peer);
  worker?.close();
  server.close(() => process.exit(0));
});

start().catch(error => { console.error('Failed to start server:', error); process.exit(1); });

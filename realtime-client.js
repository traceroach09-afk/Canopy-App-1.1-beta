import { Device } from 'mediasoup-client';

const statusEl = document.getElementById('callState');
const liveEl = document.getElementById('realtimeStatus');
const messageList = document.getElementById('messageList');
const messagesEl = document.getElementById('messages');
const callStage = document.getElementById('callStage');
const sendButton = document.getElementById('voiceCall');
const videoButton = document.getElementById('videoCall');
const callState = {
  socket: null,
  pending: new Map(),
  currentRoom: 'yapper-commons',
  currentChannel: 'general',
  peerId: null,
  device: null,
  sendTransport: null,
  recvTransport: null,
  stream: null,
  producers: new Map(),
  consumers: new Map(),
  peerMedia: new Map(),
  queuedProducers: new Map(),
  roster: new Map(),
  onlineAccountIds: new Set(),
  user: null,
  servers: [],
  selectedServer: null,
  canManageChannels: false,
  profile: null,
  pendingInviteToken: null,
  serverEmojis: new Map(),
  peerNames: new Map(),
  connected: false,
  autoReconnect: true,
  inCall: false,
  reconnectDelay: 500
};

async function api(path, options = {}) {
  if (window.location.protocol === 'file:') {
    throw new Error('Account features need the app server. Run “npm start” in the app folder, then open http://localhost:3000.');
  }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function appendAccountBadges(host, badges = [], showLabels = false) {
  if (!host || !Array.isArray(badges)) return;
  const wrap = document.createElement('span'); wrap.className = 'account-badges';
  for (const badge of badges) {
    if (!badge || !['verified', 'moderator', 'plus', 'bug-hunter'].includes(badge.id)) continue;
    const item = document.createElement('span'); item.className = `account-badge ${badge.id}`;
    item.title = badge.label;
    if (badge.id === 'verified') item.textContent = '✓';
    else if (badge.id === 'moderator') {
      item.classList.add('moderator-badge');
      if(showLabels)item.classList.add('profile-label');
      const icon=document.createElement('span');icon.className='moderator-shield';icon.textContent='✓';item.append(icon);
      if(showLabels){const label=document.createElement('span');label.textContent='Moderator';item.append(label)}
    }
    else if (badge.id === 'plus') item.textContent = 'PLUS';
    else { item.textContent = '🐛 Bug Hunter'; }
    wrap.append(item);
  }
  if (wrap.childElementCount) host.append(wrap);
}

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('loginTab').classList.toggle('selected', mode === 'login');
  document.getElementById('registerTab').classList.toggle('selected', mode === 'register');
  document.getElementById('authTitle').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
  document.getElementById('authSubtitle').textContent = mode === 'login' ? 'Sign in to meet people, join communities, and catch up with your servers.' : 'Create an account to join real communities and meet real people.';
  document.getElementById('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  document.getElementById('emailLabel').textContent = mode === 'login' ? 'EMAIL OR USERNAME' : 'EMAIL';
  document.getElementById('emailInput').type = mode === 'login' ? 'text' : 'email';
  document.getElementById('emailInput').placeholder = mode === 'login' ? 'Email address' : 'name@example.com';
  document.getElementById('passwordInput').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  document.getElementById('authError').textContent = '';
}

function renderMembers(members) {
  callState.roster = new Map(members.map(member => [member.id, member]));
  document.querySelectorAll('.author[data-user-id]').forEach(author => {
    const member=callState.roster.get(author.dataset.userId);
    author.style.color=member?.roleId&&/^#[0-9a-f]{6}$/i.test(member.roleColor||'')?member.roleColor:'';
  });
  const host = document.getElementById('membersList');
  host.replaceChildren();
  if (!members.length) { host.insertAdjacentHTML('beforeend', '<div class="member-empty">You’re the first member. Invite someone to join.</div>'); return; }
  const groups = new Map();
  for (const member of members) {
    const assignedRole = member.roleId ? (member.customRoleName || member.role) : (member.role && !['member','owner'].includes(member.role) ? member.role : '');
    const heading = assignedRole ? assignedRole.toUpperCase() : (member.online ? 'ONLINE' : 'OFFLINE');
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(member);
  }
  for (const [heading, group] of groups) {
    if (!group.length) continue;
    const label = document.createElement('h2'); label.className = 'member-title'; label.textContent = `${heading} — ${group.length}`; host.append(label);
    for (const member of group) {
      const row = document.createElement('button'); row.className = 'member'; row.type = 'button'; row.setAttribute('aria-label', `View ${member.displayName || member.username}'s profile`);
      const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.style.background = '#6377e8'; avatar.textContent = (member.displayName || member.username).slice(0,1).toUpperCase();
      if (member.online) { const dot = document.createElement('span'); dot.className = 'status-dot'; row.append(avatar); avatar.append(dot); } else row.append(avatar);
      applyAvatar(avatar, member);
      const name = document.createElement('span'); name.className = 'member-name'; name.textContent = member.displayName || member.username;
      if(member.roleId&&/^#[0-9a-f]{6}$/i.test(member.roleColor||'')){name.style.color=member.roleColor;name.style.fontWeight='700'}
      row.append(name);
      appendAccountBadges(row, member.badges);
      if(callState.selectedServer?.tag){const tag=document.createElement('span');tag.className='community-tag';tag.textContent=callState.selectedServer.tag;tag.title='Server tag';row.append(tag)}
      if (member.role === 'owner') { const badge = document.createElement('span'); badge.className = 'user-badge moderator owner-crown'; badge.textContent = '👑'; badge.title = 'Server owner'; badge.setAttribute('aria-label', 'Server owner'); row.append(badge); }
      if(!member.roleId&&member.role&&member.role!=='member'&&member.role!=='owner'){name.textContent=`${member.displayName||member.username} · ${member.role.toUpperCase()}`}
      row.onclick = () => openProfileCard(member, row);
      host.append(row);
    }
  }
}

async function renderMemberSettings() {
  const panel = document.getElementById('settingsPanel');
  panel.innerHTML = '<h1>Members</h1><p>Registered accounts in this community.</p><div class="setting-card" id="accountMemberRows">Loading members…</div>';
  try {
    const { members } = await api(`/api/servers/${callState.selectedServer.id}/members`);
    const rows = document.getElementById('accountMemberRows');
    rows.replaceChildren();
    for (const member of members) {
      const row = document.createElement('div'); row.className = 'setting-member';
      const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.style.background = '#6377e8'; avatar.textContent = (member.displayName || member.username).slice(0,1).toUpperCase(); applyAvatar(avatar, member);
      const identity = document.createElement('div'); identity.style.flex = '1';
      const display = document.createElement('strong'); display.textContent = member.displayName;
      const username = document.createElement('small'); username.style.display = 'block'; username.textContent = '@'+member.username+(member.pronouns?' · '+member.pronouns:'');
      identity.append(display, username);
      const presence = document.createElement('span'); presence.className = 'call-state'; presence.textContent = member.online ? 'Online' : 'Offline';
      row.append(avatar, identity);
      if(member.role==='owner'){const role=document.createElement('span');role.className='user-badge moderator';role.textContent='OWNER';row.append(role)}
      if(member.roleId){const role=document.createElement('span');role.className='community-tag';role.textContent=(member.customRoleName||member.role).toUpperCase();if(/^#[0-9a-f]{6}$/i.test(member.roleColor||'')){role.style.color=member.roleColor;role.style.borderColor=`${member.roleColor}90`}row.append(role)}
      else if(member.role!=='owner'){const role=document.createElement('span');role.className='community-tag';role.textContent=member.role;row.append(role)}
      row.append(presence);
      if (callState.selectedServer?.ownerUserId === callState.user?.id && member.id !== callState.user.id && member.role !== 'owner') {
        const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'subtle'; kick.textContent = 'Kick';
        kick.onclick = async () => { if (!confirm(`Remove ${member.displayName} from this community?`)) return; try { await api(`/api/servers/${callState.selectedServer.id}/members/${member.id}`, { method:'DELETE', body:JSON.stringify({ban:false}) }); renderMemberSettings(); } catch(error) { notify(error.message); } };
        const ban = document.createElement('button'); ban.type = 'button'; ban.className = 'subtle danger'; ban.textContent = 'Ban';
        ban.onclick = async () => { const reason = prompt(`Ban ${member.displayName}? Add an optional reason:`) ?? null; if (reason === null) return; try { await api(`/api/servers/${callState.selectedServer.id}/members/${member.id}`, { method:'DELETE', body:JSON.stringify({ban:true,reason}) }); renderMemberSettings(); } catch(error) { notify(error.message); } };
        row.append(kick, ban);
      }
      rows.append(row);
    }
    if (!members.length) rows.textContent = 'No account members yet.';
  } catch (error) { panel.innerHTML = `<h1>Members</h1><p>${escapeText(error.message)}</p>`; }
}

const serverSettingGroups = { 'SERVER PROFILE':['Server Profile','Channels','Promote'], EXPRESSION:['Emoji'], PEOPLE:['Members','Roles','Bans'], MODERATION:['Reports'] };
function serverSettingsAccess() { return callState.selectedServer; }
async function openServerSettings(page = 'Server Profile') {
  const server = serverSettingsAccess(); if (!server) { notify('Select a community first.'); return; }
  let moderationAccess={};try{moderationAccess=await api(`/api/servers/${server.id}/moderation-access`)}catch{}
  if(page==='Reports'&&!moderationAccess.canReviewReports){notify('Reports are available to members with the Review Reports role.');return}
  if(page==='Bans'&&!moderationAccess.canBan){notify('Bans are available to members with the Ban Members role.');return}
  document.getElementById('settingsShade').classList.add('open');
  document.getElementById('serverMenu').classList.remove('open');
  const nav = document.getElementById('settingsNav'), panel = document.getElementById('settingsPanel');
  nav.innerHTML = '<div class="settings-brand">COMMUNITY SERVER SETTINGS</div>' + Object.entries(serverSettingGroups).map(([group,items]) => {const visible=items.filter(item=>item!=='Reports'||moderationAccess.canReviewReports).filter(item=>item!=='Bans'||moderationAccess.canBan);return visible.length?`<div class="nav-label">${group}</div>`+visible.map(item=>`<button data-live-server-page="${item}" class="${page===item?'selected':''}">${item}</button>`).join(''):''}).join('');
  nav.querySelectorAll('[data-live-server-page]').forEach(button => button.onclick = () => openServerSettings(button.dataset.liveServerPage));
  panel.innerHTML = `<h1>${escapeText(page)}</h1><div class="setting-card">Loading community settings…</div>`;
  try {
    const { settings } = await api(`/api/servers/${server.id}/settings`);
    if (page === 'Server Profile') renderServerProfileSettings(settings);
    else if (page === 'Channels') await renderServerChannels(settings);
    else if (page === 'Members') await renderMemberSettings();
    else if (page === 'Roles') await renderServerRoles();
    else if (page === 'Bans') await renderServerBans();
    else if (page === 'Emoji') await renderServerEmoji();
    else if (page === 'Reports') await renderServerReports();
    else if (page === 'Promote') renderServerPromote(settings);
  } catch(error) { panel.innerHTML = `<h1>${escapeText(page)}</h1><p class="auth-error">${escapeText(error.message)}</p>`; }
}

function imageDataFromFile(file, maxBytes, label) {
  return new Promise((resolve,reject) => {
    if (!file) return resolve('');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > maxBytes) return reject(new Error(`${label} must be PNG, JPEG, WebP, or GIF under ${Math.round(maxBytes/1024/1024)} MB.`));
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read the ${label.toLowerCase()} file.`)); reader.readAsDataURL(file);
  });
}
function renderServerProfileSettings(settings) {
  const panel = document.getElementById('settingsPanel');
  const banner = settings.bannerData ? `background-image:url('${settings.bannerData}')` : 'background:linear-gradient(120deg,#253b43,#275064)';
  const icon = settings.iconData ? `<img src="${settings.iconData}" alt="Server icon">` : escapeText(settings.name.slice(0,2).toUpperCase());
  panel.innerHTML = `<h1>Server Profile</h1><p>Manage this community's profile, visibility, invite link, and safety controls.</p><form id="serverProfileForm" class="server-profile-form">
    <div class="server-preview"><div class="server-preview-banner" id="serverPreviewBanner" style="${banner}"></div><div class="server-preview-icon" id="serverPreviewIcon">${icon}</div><strong id="serverPreviewName">${escapeText(settings.name)}</strong><small>${settings.onlineCount} online · ${settings.memberCount} members</small></div>
    <section class="setting-card"><h2>SERVER ICON</h2><p>A square image works best. PNG, JPEG, WebP, or GIF, up to 1 MB.</p><input type="file" id="serverIconFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="action" data-upload="serverIconFile">Upload image</button> <button type="button" class="subtle" data-remove-image="icon">Remove</button>
    <h2>SERVER BANNER</h2><p>A wide image for the top of the channel list. Up to 2 MB.</p><div class="server-banner-preview" id="serverBannerPreview" style="${banner}"></div><input type="file" id="serverBannerFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="action" data-upload="serverBannerFile">Upload banner</button> <button type="button" class="subtle" data-remove-image="banner">Remove</button></section>
    <section class="setting-card"><label for="serverSettingName">SERVER NAME</label><input id="serverSettingName" maxlength="42" required value="${escapeText(settings.name)}"><label for="serverSettingAbout">ABOUT</label><textarea id="serverSettingAbout" maxlength="180">${escapeText(settings.about)}</textarea><label for="serverSettingFocus">COMMUNITY FOCUS</label><select id="serverSettingFocus">${['Meetups & events','Professional networking','Creative community','Local community','Hobbies & interests'].map(value=>`<option ${settings.focus===value?'selected':''}>${value}</option>`).join('')}</select><label for="serverVisibility">WHO CAN JOIN?</label><select id="serverVisibility"><option ${settings.visibility==='Public'?'selected':''}>Public</option><option ${settings.visibility==='Invite only'?'selected':''}>Invite only</option></select></section>
    <section class="setting-card"><label for="serverInviteSlug">CUSTOM INVITE LINK</label><p>${settings.memberCount < 5 && !settings.inviteSlug ? `Unlocks at 5 members (you have ${settings.memberCount}).` : 'Share this short link with members.'}</p><div class="invite-link-editor"><span>${escapeText(location.host)}/invite/</span><input id="serverInviteSlug" maxlength="24" placeholder="your-server" value="${escapeText(settings.inviteSlug||'')}" ${settings.memberCount < 5 && !settings.inviteSlug?'disabled':''}></div><label for="serverTag">SERVER TAG</label><p>2–4 letters or numbers. Members can wear it by their name.</p><input id="serverTag" maxlength="4" value="${escapeText(settings.tag||'')}" placeholder="TAG"></section>
    <section class="setting-card"><h2>DISCOVERY</h2><label class="setting-switch"><span><b>Show in Discovery</b><small>Let signed-in members find and join this public community.</small></span><input id="discoveryEnabled" type="checkbox" ${settings.discoveryEnabled?'checked':''}></label><h2>LET MEMBERS OPEN TICKETS</h2><label class="setting-switch"><span><b>Private help tickets</b><small>Allow members to open private support channels.</small></span><input id="ticketsEnabled" type="checkbox" ${settings.ticketsEnabled?'checked':''}></label><h2>RAID PROTECTION</h2><p>${settings.raidProtectionUntil>Date.now()?`Locked until ${new Date(settings.raidProtectionUntil).toLocaleString()}. New members cannot join and ordinary messages are paused.`:'Lock joining and posting temporarily when the community is being raided.'}</p><div class="server-actions"><button type="button" class="subtle" data-raid="15">Lock 15 min</button><button type="button" class="subtle" data-raid="60">Lock 1 hour</button><button type="button" class="subtle" data-raid="1440">Lock 1 day</button>${settings.raidProtectionUntil>Date.now()?'<button type="button" class="subtle" data-raid="0">Unlock</button>':''}</div></section>
    <div class="community-actions"><span id="serverSaveFeedback" role="status"></span><button class="action" type="submit">Save changes</button></div></form>
    <section class="setting-card danger-card"><h2>Delete server</h2><p>Delete this community and its messages. This cannot be undone.</p><button type="button" class="action danger-button" id="deleteCommunity">Delete server</button></section>`;
  const form=panel.querySelector('#serverProfileForm'); let iconData=settings.iconData||'', bannerData=settings.bannerData||'';
  panel.querySelectorAll('[data-upload]').forEach(button=>button.onclick=()=>panel.querySelector('#'+button.dataset.upload).click());
  panel.querySelector('#serverIconFile').onchange=async event=>{try{iconData=await imageDataFromFile(event.target.files[0],1_000_000,'Server icon');panel.querySelector('#serverPreviewIcon').innerHTML=iconData?`<img src="${iconData}" alt="Server icon">`:escapeText(settings.name.slice(0,2).toUpperCase());}catch(error){notify(error.message)}};
  panel.querySelector('#serverBannerFile').onchange=async event=>{try{bannerData=await imageDataFromFile(event.target.files[0],2_000_000,'Server banner');const style=bannerData?`background-image:url('${bannerData}')`:'background:linear-gradient(120deg,#253b43,#275064)';panel.querySelector('#serverBannerPreview').style.cssText=style;panel.querySelector('#serverPreviewBanner').style.cssText=style;}catch(error){notify(error.message)}};
  panel.querySelectorAll('[data-remove-image]').forEach(button=>button.onclick=()=>{if(button.dataset.removeImage==='icon'){iconData='';panel.querySelector('#serverPreviewIcon').textContent=settings.name.slice(0,2).toUpperCase()}else{bannerData='';panel.querySelector('#serverBannerPreview').style.backgroundImage='';panel.querySelector('#serverPreviewBanner').style.backgroundImage=''}});
  panel.querySelector('#serverSettingName').oninput=event=>panel.querySelector('#serverPreviewName').textContent=event.target.value;
  form.onsubmit=async event=>{event.preventDefault();const feedback=panel.querySelector('#serverSaveFeedback');try{const result=await api(`/api/servers/${settings.id}/settings`,{method:'PATCH',body:JSON.stringify({name:panel.querySelector('#serverSettingName').value,about:panel.querySelector('#serverSettingAbout').value,focus:panel.querySelector('#serverSettingFocus').value,visibility:panel.querySelector('#serverVisibility').value,iconData,bannerData,tag:panel.querySelector('#serverTag').value,inviteSlug:panel.querySelector('#serverInviteSlug').value,discoveryEnabled:panel.querySelector('#discoveryEnabled').checked,ticketsEnabled:panel.querySelector('#ticketsEnabled').checked})});feedback.textContent='Saved';await loadServers();const fresh=callState.servers.find(item=>item.id===settings.id);if(fresh)selectServerUI(fresh);notify('Community settings saved');}catch(error){feedback.textContent=error.message;}};
  panel.querySelector('#serverVisibility').onchange=event=>{const discovery=panel.querySelector('#discoveryEnabled');if(event.target.value==='Invite only'){discovery.checked=false;discovery.disabled=true}else discovery.disabled=false};
  panel.querySelectorAll('[data-raid]').forEach(button=>button.onclick=async()=>{try{await api(`/api/servers/${settings.id}/raid`,{method:'POST',body:JSON.stringify({minutes:Number(button.dataset.raid)})});openServerSettings('Server Profile');}catch(error){notify(error.message)}});
  panel.querySelector('#deleteCommunity').onclick=async()=>{if(!confirm(`Delete ${settings.name}? This removes its channels and messages.`))return;try{await api(`/api/servers/${settings.id}`,{method:'DELETE'});document.getElementById('settingsShade').classList.remove('open');await loadServers();if(callState.selectedServer)await setRoom(callState.selectedServer.id);notify('Community deleted');}catch(error){notify(error.message)}};
}

async function renderServerChannels(settings) {
  const panel=document.getElementById('settingsPanel'), {channels,canManage}=await api(`/api/servers/${settings.id}/channels`);
  panel.innerHTML=`<h1>Channels</h1><p>Create and manage the places where community members meet.</p>${canManage?'<form id="newServerChannel" class="setting-card"><label>CHANNEL NAME</label><input name="name" required maxlength="40" placeholder="meetup-planning"><label>TYPE</label><select name="type"><option value="text">Text</option><option value="voice">Voice</option></select><label>TOPIC</label><input name="topic" maxlength="120" placeholder="What is this channel for?"><button class="action">Create channel</button><span class="auth-error" id="channelFeedback" role="status"></span></form>':'<p>You need the Manage Channels permission to create or edit channels.</p>'}<div class="setting-card" id="channelSettingsRows"></div>`;
  const rows=panel.querySelector('#channelSettingsRows');
  for(const channel of channels){const row=document.createElement('div');row.className='setting-member';const name=document.createElement('strong');name.textContent=(channel.type==='voice'?'◖　':'#　')+channel.name;const topic=document.createElement('small');topic.textContent=channel.topic||channel.type;topic.style.flex='1';row.append(name,topic);if(canManage){const edit=document.createElement('button');edit.className='subtle';edit.textContent='Edit';edit.onclick=()=>openEditChannelDialog(settings.id,channel);row.append(edit);if(channel.name!=='general'){const remove=document.createElement('button');remove.className='subtle danger';remove.textContent='Delete';remove.onclick=async()=>{if(!confirm(`Delete #${channel.name} and its messages?`))return;try{await api(`/api/servers/${settings.id}/channels/${channel.id}`,{method:'DELETE'});await loadServerChannels(settings.id);openServerSettings('Channels')}catch(error){notify(error.message)}};row.append(remove)}}rows.append(row)}
  if(canManage)panel.querySelector('#newServerChannel').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;try{await api(`/api/servers/${settings.id}/channels`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});await loadServerChannels(settings.id);openServerSettings('Channels')}catch(error){panel.querySelector('#channelFeedback').textContent=error.message}};
}

async function openEditChannelDialog(serverId, channel) {
  try {
    const {roles}=await api(`/api/servers/${serverId}/roles`);
    const shade=document.getElementById('communityShade'),body=document.getElementById('communityBody');
    document.getElementById('communityTitle').textContent='Edit channel';
    document.getElementById('communitySubtitle').textContent='Choose who can see and post in this channel.';
    const selected=new Set(channel.allowedRoles||[]);
    body.innerHTML=`<form id="channelEditForm" class="channel-edit-form">
      <label for="editChannelName">CHANNEL NAME</label><input id="editChannelName" name="name" maxlength="40" required value="${escapeText(channel.name)}">
      <label for="editChannelTopic">CHANNEL TOPIC</label><input id="editChannelTopic" name="topic" maxlength="120" value="${escapeText(channel.topic||'')}">
      <label class="channel-edit-option"><span><strong>Private Channel　🔒</strong><small>Only the roles you pick (plus managers) can see and use it.</small></span><input type="checkbox" name="privateChannel" ${channel.privateChannel?'checked':''}></label>
      <label class="channel-edit-option"><span><strong>Text only</strong><small>No pictures, files or GIFs in this channel, except from managers and mods.</small></span><input type="checkbox" name="textOnly" ${channel.textOnly?'checked':''}></label>
      <label class="channel-edit-option"><span><strong>Read-only　⚑</strong><small>Everyone can read and react, but only the roles you pick (plus managers) can post.</small></span><input type="checkbox" name="readOnly" ${channel.readOnly||channel.locked?'checked':''}></label>
      <label for="editChannelSlowmode">Slowmode</label><select id="editChannelSlowmode" name="slowmodeSeconds"><option value="0">Off</option>${[[5,'5 seconds'],[10,'10 seconds'],[15,'15 seconds'],[30,'30 seconds'],[60,'1 minute'],[120,'2 minutes'],[300,'5 minutes'],[600,'10 minutes']].map(([value,label])=>`<option value="${value}" ${Number(channel.slowmodeSeconds)===value?'selected':''}>${label}</option>`).join('')}</select>
      <fieldset class="channel-role-choices"><legend>ROLES ALLOWED</legend><p>Selected roles can view private channels and post in read-only channels.</p>${roles.length?roles.map(role=>`<label><input type="checkbox" name="allowedRoles" value="${escapeText(role.id)}" ${selected.has(role.id)?'checked':''}> <span class="role-color-dot" style="background:${escapeText(role.color)}"></span>${escapeText(role.name)}</label>`).join(''):'<small>Create a role first to grant channel access.</small>'}</fieldset>
      <div class="community-actions"><button type="button" class="subtle" id="cancelChannelEdit">Cancel</button><button class="action">Save changes</button></div>
    </form>`;
    shade.classList.add('open');
    document.getElementById('cancelChannelEdit').onclick=()=>shade.classList.remove('open');
    body.querySelector('#channelEditForm').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,formData=new FormData(form);
      const payload={name:formData.get('name'),topic:formData.get('topic'),privateChannel:formData.has('privateChannel'),textOnly:formData.has('textOnly'),readOnly:formData.has('readOnly'),slowmodeSeconds:Number(formData.get('slowmodeSeconds')),allowedRoles:formData.getAll('allowedRoles')};
      try{const result=await api(`/api/servers/${serverId}/channels/${channel.id}`,{method:'PATCH',body:JSON.stringify(payload)});if(callState.currentChannel===channel.name){callState.currentChannel=result.channel.name;if(callState.socket?.readyState===WebSocket.OPEN)setRoom(serverId,result.channel.name)}shade.classList.remove('open');await loadServerChannels(serverId);notify('Channel updated')}catch(error){notify(error.message)}
    };
  }catch(error){notify(error.message)}
}

async function loadServerChannels(serverId) {
  try {
    const {channels,canManage}=await api(`/api/servers/${serverId}/channels`), host=document.querySelector('.channel-scroll');
    if(!host)return;
    clearTimeout(callState.timeoutRefreshTimer);const timeoutExpiry=Math.min(...channels.map(channel=>Number(channel.timedOutUntil||0)).filter(Boolean));if(Number.isFinite(timeoutExpiry))callState.timeoutRefreshTimer=setTimeout(()=>loadServerChannels(serverId),Math.min(Math.max(0,timeoutExpiry-Date.now()+250),2_147_000_000));
    if(!canManage&&!channels.some(channel=>channel.name===callState.currentChannel)){const fallback=channels.find(channel=>channel.name==='general')||channels[0];if(fallback){callState.currentChannel=fallback.name;if(callState.socket?.readyState===WebSocket.OPEN)setRoom(serverId,fallback.name)}}
    callState.canManageChannels=canManage;
    const menuCreate=document.querySelector('#serverMenu [data-setting="Channels"]');if(menuCreate)menuCreate.hidden=!canManage;
    const banner=host.querySelector('.server-banner-strip');
    host.innerHTML='';
    const strip=document.createElement('div');strip.className='server-banner-strip';strip.style.backgroundImage=callState.selectedServer?.bannerData?`url("${callState.selectedServer.bannerData}")`:'';strip.textContent=callState.selectedServer?.name?.toUpperCase()||'COMMUNITY';host.append(strip);
    for(const [type,label] of [['text','TEXT CHANNELS'],['voice','VOICE CHANNELS']]){
      const group=channels.filter(channel=>channel.type===type);if(!group.length)continue;
      const heading=document.createElement('div');heading.className='category';heading.innerHTML=`<span>⌄</span> ${label}`;
      if(canManage){const create=document.createElement('button');create.type='button';create.className='plus';create.dataset.createChannel='true';create.dataset.channelType=type;create.setAttribute('aria-label',`Create ${type} channel`);create.title=`Create ${type} channel`;create.textContent='＋';heading.append(create)}
      host.append(heading);
      for(const channel of group){
        const row=document.createElement('div');row.className='channel-row';
        const button=document.createElement('button');button.type='button';button.className=`channel ${type==='voice'?'voice':''}`;button.dataset.channel=channel.name;button.dataset.channelType=channel.type;button.dataset.channelId=channel.id;button.dataset.channelCanPost=channel.canPost?'true':'false';button.dataset.channelTimedout=channel.timedOutUntil||'';button.dataset.channelTextOnly=channel.textOnly?'true':'false';button.dataset.channelCanUpload=channel.canUpload?'true':'false';button.classList.toggle('active',channel.name===callState.currentChannel);button.innerHTML=`<span class="hash">${type==='voice'?'◖':'#'}</span> ${escapeText(channel.name)}`;button.title=channel.topic||channel.name;row.append(button);
        if(canManage){
          const tools=document.createElement('span');tools.className='channel-tools';
          const edit=document.createElement('button');edit.type='button';edit.className='channel-tool';edit.textContent='✎';edit.title='Edit channel';edit.setAttribute('aria-label',edit.title);edit.onclick=event=>{event.stopPropagation();openEditChannelDialog(serverId,channel)};tools.append(edit);
          const remove=document.createElement('button');remove.type='button';remove.className='channel-tool danger';remove.textContent='🗑';remove.title=channel.name==='general'?'The general channel cannot be deleted':'Delete channel';remove.setAttribute('aria-label',remove.title);remove.disabled=channel.name==='general';remove.onclick=async event=>{event.stopPropagation();if(!confirm(`Delete #${channel.name} and its messages?`))return;try{await api(`/api/servers/${serverId}/channels/${channel.id}`,{method:'DELETE'});if(callState.currentChannel===channel.name){callState.currentChannel='general';if(callState.socket?.readyState===WebSocket.OPEN)setRoom(serverId,'general')}await loadServerChannels(serverId);notify('Channel deleted')}catch(error){notify(error.message)}};tools.append(remove);row.append(tools);
        }
        host.append(row);
      }
    }
    const activeChannel=host.querySelector('.channel.active');
    if(activeChannel){const blocked=activeChannel.dataset.channelCanPost==='false',voice=activeChannel.dataset.channelType==='voice',textOnly=activeChannel.dataset.channelTextOnly==='true',canUpload=activeChannel.dataset.channelCanUpload==='true';document.querySelectorAll('#composer button,#messageInput').forEach(control=>control.disabled=blocked||voice||(textOnly&&!canUpload&&control.matches('[data-media-tool]')));document.getElementById('messageInput').placeholder=activeChannel.dataset.channelTimedout?`Timed out until ${new Date(Number(activeChannel.dataset.channelTimedout)).toLocaleString()}`:blocked?'You need an allowed role to post here':voice?`Voice channel · ${activeChannel.dataset.channel}`:`Message #${activeChannel.dataset.channel}`}
  }catch(error){console.warn('Could not load community channels:',error)}
}

async function renderServerRoles() {
  const panel=document.getElementById('settingsPanel'), server=callState.selectedServer;
  const [{roles,canGrantModeration},{members},{permissions:defaultPermissions}]=await Promise.all([api(`/api/servers/${server.id}/roles`),api(`/api/servers/${server.id}/members`),api(`/api/servers/${server.id}/default-permissions`)]);
  const rolePermissionOptions=[['manageServer','Manage Server'],['manageChannels','Manage Channels'],['manageRoles','Manage Roles'],['manageEmoji','Manage Emoji'],['createInvite','Create Invite'],['kickMembers','Kick Members'],['reviewReports','Review Reports'],['timeoutMembers','Timeout Members'],['banMembers','Ban Members']];
  panel.innerHTML=`<h1>Roles</h1><p>Create roles, set their permissions, and assign them to registered members. The app-wide Moderator badge grants report review, timeout, and ban powers in communities the member joins. Only the server owner can grant these permissions by role.</p><section class="setting-card" id="defaultRolePermissions"><h2>Default permissions · everyone</h2><p>These permissions apply to members without another role. Moderation actions cannot be assigned to everyone.</p><div class="role-permissions">${rolePermissionOptions.slice(0,6).map(([key,label])=>`<label><input type="checkbox" value="${key}" ${defaultPermissions.includes(key)?'checked':''}> ${label}</label>`).join('')}</div><button type="button" class="action" id="saveDefaultPermissions">Save default permissions</button></section><form id="createRoleForm" class="setting-card"><label>NEW ROLE</label><input name="name" maxlength="32" placeholder="Event host" required><label>ROLE COLOR</label><input name="color" type="color" value="#3989ff"><button class="action">Create role</button></form><div id="roleRows"></div>`;
  panel.querySelector('#saveDefaultPermissions').onclick=async()=>{const permissions=[...panel.querySelectorAll('#defaultRolePermissions input:checked')].map(input=>input.value);try{await api(`/api/servers/${server.id}/default-permissions`,{method:'PUT',body:JSON.stringify({permissions})});notify('Default permissions saved')}catch(error){notify(error.message)}};
  const host=panel.querySelector('#roleRows');
  for(const role of roles){const card=document.createElement('section');card.className='setting-card role-card';card.innerHTML=`<div class="setting-member"><span class="role-color-dot" style="background:${role.color}"></span><input class="role-name-input" aria-label="Role name" maxlength="32" value="${escapeText(role.name)}"><input aria-label="Role color" type="color" value="${role.color}"><button type="button" class="subtle" data-save-role>Save</button><button type="button" class="subtle danger" data-delete-role>Delete</button></div><label>PERMISSIONS</label><div class="role-permissions">${rolePermissionOptions.map(([key,label])=>`<label><input type="checkbox" value="${key}" ${role.permissions.includes(key)?'checked':''} ${['reviewReports','timeoutMembers','banMembers'].includes(key)&&!canGrantModeration?'disabled title="Only the server owner can grant this permission"':''}> ${label}</label>`).join('')}</div><label>ASSIGN TO MEMBERS</label><div class="role-member-assignments">${members.map(member=>`<label><input type="checkbox" data-member-role="${member.id}" ${member.roleId===role.id?'checked':''}> ${escapeText(member.displayName||member.username)}</label>`).join('')||'<small>No members to assign yet.</small>'}</div></section>`;
    card.querySelector('[data-save-role]').onclick=async()=>{const name=card.querySelector('.role-name-input').value,color=card.querySelector('[type=color]').value,permissions=[...card.querySelectorAll('.role-permissions input:checked')].map(input=>input.value);try{await api(`/api/servers/${server.id}/roles/${role.id}`,{method:'PATCH',body:JSON.stringify({name,color,permissions})});notify('Role saved');await refreshRoleViews();renderServerRoles()}catch(error){notify(error.message)}};
    card.querySelector('[data-delete-role]').onclick=async()=>{if(!confirm(`Delete the ${role.name} role?`))return;try{await api(`/api/servers/${server.id}/roles/${role.id}`,{method:'DELETE'});await refreshRoleViews();renderServerRoles()}catch(error){notify(error.message)}};
    card.querySelectorAll('[data-member-role]').forEach(input=>input.onchange=async()=>{try{await api(`/api/servers/${server.id}/members/${input.dataset.memberRole}`,{method:'PATCH',body:JSON.stringify({roleId:input.checked?role.id:''})});await refreshRoleViews();renderServerRoles()}catch(error){notify(error.message);input.checked=!input.checked}});host.append(card);
  }
  panel.querySelector('#createRoleForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;try{await api(`/api/servers/${server.id}/roles`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});await refreshRoleViews();renderServerRoles()}catch(error){notify(error.message)}};
}

async function renderServerBans(){const panel=document.getElementById('settingsPanel'),server=callState.selectedServer,{bans}=await api(`/api/servers/${server.id}/bans`);panel.innerHTML=`<h1>Bans · ${bans.length}</h1><p>People banned from this community cannot rejoin by invite or discovery.</p><div class="setting-card" id="banRows"></div>`;const rows=panel.querySelector('#banRows');if(!bans.length){rows.textContent='Nobody is banned.';return}for(const ban of bans){const row=document.createElement('div');row.className='setting-member';row.innerHTML=`<div><strong>${escapeText(ban.displayName||ban.username)}</strong><small>${escapeText(ban.reason||'No reason provided')}</small></div><button type="button" class="subtle">Unban</button>`;row.querySelector('button').onclick=async()=>{try{await api(`/api/servers/${server.id}/bans/${ban.userId}`,{method:'DELETE'});renderServerBans()}catch(error){notify(error.message)}};rows.append(row)}}

async function renderServerEmoji(){const panel=document.getElementById('settingsPanel'),server=callState.selectedServer,{emojis}=await api(`/api/servers/${server.id}/emojis`);panel.innerHTML=`<h1>Emoji · ${emojis.length} / 50</h1><p>Upload PNG, JPEG, WebP, or GIF emoji up to 200 KB. Select one to add its code in chat.</p><form id="emojiUploadForm" class="setting-card"><label>EMOJI NAME</label><input name="name" maxlength="32" placeholder="wave" required><input id="emojiFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required><button class="action">Upload Emoji</button></form><div class="setting-card" id="emojiRows"></div>`;panel.querySelector('#emojiUploadForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;try{const imageData=await imageDataFromFile(panel.querySelector('#emojiFile').files[0],200_000,'Emoji image');await api(`/api/servers/${server.id}/emojis`,{method:'POST',body:JSON.stringify({name:form.elements.name.value,imageData})});renderServerEmoji()}catch(error){notify(error.message)}};const rows=panel.querySelector('#emojiRows');if(!emojis.length)rows.textContent='No community emoji yet.';for(const emoji of emojis){const row=document.createElement('div');row.className='setting-member';const insert=document.createElement('button');insert.type='button';insert.className='emoji-insert';insert.innerHTML=`<img width="36" height="36" src="${emoji.imageData}" alt=":${escapeText(emoji.name)}:"><strong> :${escapeText(emoji.name)}:</strong>`;insert.onclick=()=>{const input=document.getElementById('messageInput');input.value+=` :${emoji.name}:`;input.focus();notify(`Added :${emoji.name}: to chat`)};const remove=document.createElement('button');remove.type='button';remove.className='subtle danger';remove.textContent='Remove';remove.onclick=async()=>{try{await api(`/api/servers/${server.id}/emojis/${emoji.id}`,{method:'DELETE'});renderServerEmoji()}catch(error){notify(error.message)}};row.append(insert,remove);rows.append(row)}}

async function renderServerReports(){
  const panel=document.getElementById('settingsPanel'),server=callState.selectedServer,{reports,canBan,canTimeout,canManageTickets}=await api(`/api/servers/${server.id}/reports`);
  let tickets=[];if(canManageTickets)try{tickets=(await api(`/api/servers/${server.id}/tickets`)).tickets}catch{}
  panel.innerHTML=`<h1>Reports · ${reports.filter(report=>report.status==='open').length} open</h1><p>Review member reports. Use the available actions to ban someone or time them out for a chosen duration.</p><h2>MEMBER REPORTS</h2><div class="setting-card" id="reportRows"></div>${canManageTickets?'<h2>SUPPORT TICKETS</h2><div class="setting-card" id="ticketRows"></div>':''}`;
  const rows=panel.querySelector('#reportRows');if(!reports.length)rows.textContent='Nothing to review.';
  for(const report of reports){const row=document.createElement('div');row.className='setting-member report-row';const actions=document.createElement('div');actions.className='report-actions';const detail=document.createElement('div');detail.innerHTML=`<strong>${escapeText(report.reporter)} reported ${escapeText(report.reportedUser||'a member')}</strong><p>${escapeText(report.reason)}</p><blockquote>${escapeText(report.message||'[message unavailable]')}</blockquote><small>${new Date(report.createdAt).toLocaleString()} · ${escapeText(report.status)}${report.timeoutExpiresAt?` · Timed out until ${new Date(report.timeoutExpiresAt).toLocaleString()}`:''}</small>`;row.append(detail);if(report.status==='open'){
    if(canBan){const ban=document.createElement('button');ban.type='button';ban.className='subtle danger';ban.textContent='Ban';ban.onclick=async()=>{if(!confirm(`Ban ${report.reportedUser||'this member'} from the community?`))return;try{await api(`/api/servers/${server.id}/reports/${report.id}`,{method:'PATCH',body:JSON.stringify({action:'ban'})});notify('Member banned and report handled');renderServerReports()}catch(error){notify(error.message)}};actions.append(ban)}
    if(canTimeout){const duration=document.createElement('select');duration.setAttribute('aria-label','Timeout duration');duration.innerHTML='<option value="1">1 minute</option><option value="10">10 minutes</option><option value="60" selected>1 hour</option><option value="360">6 hours</option><option value="1440">1 day</option><option value="10080">7 days</option><option value="40320">28 days</option><option value="custom">Custom minutes…</option>';const custom=document.createElement('input');custom.type='number';custom.min='1';custom.max='40320';custom.placeholder='Minutes';custom.setAttribute('aria-label','Custom timeout minutes');custom.hidden=true;duration.onchange=()=>custom.hidden=duration.value!=='custom';const timeout=document.createElement('button');timeout.type='button';timeout.className='subtle';timeout.textContent='Timeout';timeout.onclick=async()=>{const durationMinutes=duration.value==='custom'?Number(custom.value):Number(duration.value);if(!Number.isInteger(durationMinutes)||durationMinutes<1||durationMinutes>40320){notify('Choose a timeout from 1 minute to 28 days.');return}try{await api(`/api/servers/${server.id}/reports/${report.id}`,{method:'PATCH',body:JSON.stringify({action:'timeout',durationMinutes})});notify(`Member timed out for ${durationMinutes} minute${durationMinutes===1?'':'s'}`);renderServerReports()}catch(error){notify(error.message)}};actions.append(duration,custom,timeout)}
    for(const [label,status] of [['Handle','handled'],['Dismiss','dismissed']]){const button=document.createElement('button');button.type='button';button.className='subtle';button.textContent=label;button.onclick=async()=>{try{await api(`/api/servers/${server.id}/reports/${report.id}`,{method:'PATCH',body:JSON.stringify({status})});renderServerReports()}catch(error){notify(error.message)}};actions.append(button)}row.append(actions)}rows.append(row)}
  const ticketRows=panel.querySelector('#ticketRows');if(ticketRows&&!tickets.length)ticketRows.textContent='No support tickets.';
  if(ticketRows)for(const ticket of tickets){const row=document.createElement('div');row.className='setting-member report-row';row.innerHTML=`<div><strong>${escapeText(ticket.title)} · @${escapeText(ticket.username)}</strong><p>${escapeText(ticket.details||'No details provided')}</p><small>${new Date(ticket.createdAt).toLocaleString()} · ${escapeText(ticket.status)}</small></div>`;const open=document.createElement('button');open.type='button';open.className='subtle';open.textContent='Open';open.onclick=()=>openTicketConversation(server,ticket);row.append(open);if(ticket.status==='open'){const close=document.createElement('button');close.type='button';close.className='subtle';close.textContent='Close ticket';close.onclick=async()=>{try{await api(`/api/servers/${server.id}/tickets/${ticket.id}`,{method:'PATCH',body:'{}'});renderServerReports()}catch(error){notify(error.message)}};row.append(close)}ticketRows.append(row)}
}

function renderServerPromote(settings){const panel=document.getElementById('settingsPanel');panel.innerHTML=`<h1>Promote</h1><p>Feature your public community in Canopy Discovery for a week. Promotion is free in this app.</p><div class="setting-card"><h2>${escapeText(settings.name)}</h2><p>${settings.memberCount} registered members · ${settings.onlineCount||0} online</p><p>${settings.featuredUntil>Date.now()?`Featured until ${new Date(settings.featuredUntil).toLocaleString()}.`:'Not currently featured.'}</p><button type="button" class="action" id="featureCommunity" ${settings.visibility!=='Public'?'disabled':''}>Feature for 7 days</button><p class="auth-error" id="featureFeedback"></p></div>`;panel.querySelector('#featureCommunity').onclick=async()=>{try{await api(`/api/servers/${settings.id}/feature`,{method:'POST',body:'{}'});openServerSettings('Promote')}catch(error){panel.querySelector('#featureFeedback').textContent=error.message}}}

function applyAvatar(element, profile = {}) {
  if (!element) return;
  const initial = String(profile.displayName || profile.username || '?').slice(0, 1).toUpperCase();
  const status = element.querySelector(':scope > .status-dot');
  element.textContent = profile.avatarData ? '' : initial;
  if (status) element.append(status);
  element.style.backgroundImage = profile.avatarData ? `url("${profile.avatarData}")` : '';
  element.style.backgroundPosition = 'center';
  element.style.backgroundSize = 'cover';
  element.style.color = profile.avatarData ? 'transparent' : 'white';
  element.classList.remove(...[...element.classList].filter(name => name.startsWith('frame-') || name.startsWith('decoration-')));
  const frame = String(profile.frame || 'None').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (frame !== 'none') element.classList.add(`frame-${frame}`);
  element.querySelector('.avatar-decoration')?.remove();
  const icons = { Flames: '🔥', Crown: '👑', Halo: '😇', Horns: '😈', 'Cat ears': '🐱', Wings: '🪽', Headphones: '🎧' };
  if (icons[profile.decoration]) {
    element.classList.add('decoration-accessory');
    const badge = document.createElement('span'); badge.className = 'avatar-decoration'; badge.textContent = icons[profile.decoration]; element.append(badge);
  } else {
    element.classList.remove('decoration-accessory');
    const decoration = String(profile.decoration || 'None').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (decoration !== 'none') element.classList.add(`decoration-${decoration}`);
  }
}

const profileThemes = [
  { name: 'None', primary: '#263743', accent: '#2eb9b4' },
  { name: 'Sunset', primary: '#ff805e', accent: '#ffc15e' },
  { name: 'Ocean', primary: '#0b6477', accent: '#38c7d4' },
  { name: 'Grape', primary: '#6034a9', accent: '#d52aa8' },
  { name: 'Mint', primary: '#138c65', accent: '#39d2a1' },
  { name: 'Midnight', primary: '#14253a', accent: '#364e67' },
  { name: 'Cherry', primary: '#7e2438', accent: '#ff4f57' },
  { name: 'Gold', primary: '#815b08', accent: '#ffc629' },
  { name: 'Aurora', primary: '#066f9f', accent: '#37d2dc' },
  { name: 'Rose', primary: '#9e5969', accent: '#ffc3c9' },
  { name: 'Forest', primary: '#1c583f', accent: '#62a779' },
  { name: 'Neon', primary: '#075a69', accent: '#10d2c6' },
  { name: 'Candy', primary: '#ba5e92', accent: '#ff78a8' }
];
const profileDecorations = [
  'None', 'Aurora', 'Blue Flame', 'Chromatic', 'Eclipse', 'Ember', 'Frost', 'Galaxy',
  'Gold', 'Hearts', 'Ice', 'Nebula', 'Neon', 'Obsidian', 'Ocean', 'Pearl', 'Prism',
  'Rainbow', 'Royal', 'Sparkle', 'Toxic',
  // Keep older accessory selections available so existing profiles remain editable.
  'Flames', 'Crown', 'Halo', 'Horns', 'Cat ears', 'Wings', 'Headphones'
];
const profileFrames = ['None', 'Rainbow', 'Fire', 'Ice', 'Gold', 'Sparkle', 'Galaxy', 'Neon', 'Hearts', 'Toxic'];

function renderProfileRoleBadges(profile) {
  const owner=document.getElementById('profileCardRole'),custom=document.getElementById('profileCardCustomRole');
  owner.textContent='SERVER OWNER';owner.hidden=profile.role!=='owner';
  custom.textContent=profile.roleId?(profile.customRoleName||(profile.role!=='owner'?profile.role:'')):'';custom.hidden=!custom.textContent;
  const color=/^#[0-9a-f]{6}$/i.test(profile.roleColor||'')?profile.roleColor:'#3989ff';
  custom.style.backgroundColor=`${color}2b`;custom.style.borderColor=`${color}90`;custom.style.color=color;
  const badgeHost=document.getElementById('profileCardBadges');badgeHost.replaceChildren();appendAccountBadges(badgeHost,profile.badges,true);
}

async function loadCreatorBadgeControls(profile, shade) {
  const button=document.getElementById('profileCardManageBadges'),editor=document.getElementById('profileBadgeEditor');
  button.hidden=!callState.user?.isCreator;
  editor.hidden=true;editor.replaceChildren();
  if(!callState.user?.isCreator||!profile.id)return;
  button.onclick=async()=>{
    if(!editor.hidden){editor.hidden=true;return}
    button.disabled=true;
    try{
      const {badges}=await api('/api/creator/badges');
      if(shade.dataset.profileId!==profile.id)return;
      const selected=new Set((profile.badges||[]).map(badge=>badge.id));
      editor.replaceChildren();
      for(const badge of badges){
        const label=document.createElement('label');label.className='creator-badge-option';
        const input=document.createElement('input');input.type='checkbox';input.value=badge.id;input.checked=selected.has(badge.id);
        const preview=document.createElement('span');appendAccountBadges(preview,[badge],true);
        label.append(input,preview);editor.append(label);
      }
      const actions=document.createElement('div');actions.className='creator-badge-actions';
      const save=document.createElement('button');save.type='button';save.className='action';save.textContent='Save badges';
      const feedback=document.createElement('small');
      save.onclick=async()=>{save.disabled=true;feedback.textContent='Saving…';try{
        const chosen=[...editor.querySelectorAll('input:checked')].map(input=>input.value);
        const result=await api(`/api/creator/users/${encodeURIComponent(profile.id)}/badges`,{method:'PATCH',body:JSON.stringify({badges:chosen})});
        profile.badges=result.badges;const member=callState.roster.get(profile.id);if(member){member.badges=result.badges;renderMembers([...callState.roster.values()])}
        renderProfileRoleBadges(profile);editor.hidden=true;notify('Badges updated');
      }catch(error){feedback.textContent=error.message}finally{save.disabled=false}};
      actions.append(save,feedback);editor.append(actions);editor.hidden=false;
    }catch(error){notify(error.message)}finally{button.disabled=false}
  };
}

async function refreshRoleViews(){
  const server=callState.selectedServer;if(!server)return;
  await loadServerChannels(server.id);
  const {members}=await api(`/api/servers/${server.id}/members`);renderMembers(members);
  const shade=document.getElementById('profileCardShade'),profileId=shade.dataset.profileId;
  const profile=members.find(member=>member.id===profileId);
  if(shade.classList.contains('open')&&profile){renderProfileRoleBadges(profile);await loadProfileRoleControls(profile,shade)}
}

async function loadProfileRoleControls(profile, shade) {
  const add=document.getElementById('profileCardAddRole'),editor=document.getElementById('profileCardRoleEditor'),select=document.getElementById('profileCardRoleSelect'),feedback=document.getElementById('profileRoleFeedback');
  const server=callState.selectedServer;if(!server||!profile.id)return;
  try{
    const {roles,canManage}=await api(`/api/servers/${server.id}/roles`);
    if(shade.dataset.profileId!==profile.id||callState.selectedServer?.id!==server.id)return;
    select.replaceChildren(new Option('No custom role',''),...roles.map(role=>new Option(role.name,role.id)));
    select.value=profile.roleId||'';add.hidden=!(canManage||profile.role==='owner');
    add.onclick=()=>{if(!roles.length){openServerSettings('Roles');return}editor.hidden=false;feedback.textContent='Roles are managed in Server Settings → Roles.'};
    document.getElementById('cancelProfileRole').onclick=()=>{editor.hidden=true;feedback.textContent=''};
    document.getElementById('saveProfileRole').onclick=async()=>{
      const button=document.getElementById('saveProfileRole'),roleId=select.value;button.disabled=true;feedback.textContent='Saving role…';
      try{
        await api(`/api/servers/${server.id}/members/${profile.id}`,{method:'PATCH',body:JSON.stringify({roleId})});
        const chosen=roles.find(role=>role.id===roleId),oldMember=callState.roster.get(profile.id)||profile;
        const updated={...oldMember,roleId:chosen?.id||null,roleColor:chosen?.color||'',customRoleName:chosen?.name||'',role:oldMember.role==='owner'?'owner':(chosen?.name||'member')};
        callState.roster.set(profile.id,updated);renderMembers([...callState.roster.values()]);
        profile={...updated};renderProfileRoleBadges(profile);editor.hidden=true;feedback.textContent='';notify(chosen?`${chosen.name} role assigned`:'Custom role removed');
      }catch(error){feedback.textContent=error.message}finally{button.disabled=false}
    };
  }catch(error){if(shade.dataset.profileId===profile.id){add.hidden=true;feedback.textContent=error.message}}
}

function openProfileCard(profile = callState.profile || callState.user || {}, anchor = null) {
  const isSelf = profile.id === callState.user?.id || profile.accountId === callState.user?.id || profile.username === callState.user?.username;
  if(isSelf&&!profile.id)profile={...profile,id:callState.user?.id};
  if(isSelf&&callState.roster.has(profile.id))profile={...callState.roster.get(profile.id),...profile};
  if (isSelf && callState.profile) profile = { ...profile, ...callState.profile };
  const shade = document.getElementById('profileCardShade');
  shade.dataset.profileId=profile.id||'';
  const primary = profile.primaryColor || '#263743';
  const accent = profile.accentColor || '#2eb9b4';
  const card = shade.querySelector('.profile-popover');
  card.style.setProperty('--profile-primary', primary);
  card.style.setProperty('--profile-accent', accent);
  const banner = document.getElementById('profileCardBanner');
  banner.style.backgroundImage = profile.bannerData ? `url("${profile.bannerData}")` : `linear-gradient(120deg,${primary},${accent})`;
  const avatar = document.getElementById('profileCardAvatar');
  applyAvatar(avatar, profile);
  const profileName=document.getElementById('profileCardName');profileName.textContent = profile.displayName || profile.username || 'Your profile';
  profileName.style.color=profile.roleId&&/^#[0-9a-f]{6}$/i.test(profile.roleColor||'')?profile.roleColor:'';
  document.getElementById('profileCardHandle').textContent = `@${profile.username || ''}${profile.pronouns ? ` · ${profile.pronouns}` : ''}`;
  const status = document.getElementById('profileCardStatus');
  const isOnline = typeof profile.online === 'boolean' ? profile.online : callState.connected;
  status.textContent = isOnline ? 'Online' : (isSelf ? 'Connecting…' : 'Offline');
  document.querySelector('.profile-card-status-dot').classList.toggle('offline', !isOnline);
  renderProfileRoleBadges(profile);
  const rolesSection=document.getElementById('profileRolesSection');
  rolesSection.hidden=!(profile.roleId||profile.customRoleName||(['owner','admin','moderator'].includes(String(profile.role||'').toLowerCase())));
  loadCreatorBadgeControls(profile,shade);
  document.getElementById('profileCardAddRole').hidden=true;
  document.getElementById('profileCardRoleEditor').hidden=true;
  document.getElementById('profileCardEdit').hidden = !isSelf;
  const about = document.getElementById('profileCardAbout');
  about.textContent = profile.aboutMe || (isSelf ? 'Add an About Me in your profile settings.' : 'No About Me yet.');
  about.hidden = isSelf && !profile.aboutMe;
  document.getElementById('profileAboutSection').hidden=about.hidden;
  const links=(Array.isArray(profile.links)?profile.links:[]).filter(link=>link&&typeof link.url==='string'&&/^https?:\/\//i.test(link.url));
  const linksSection=document.getElementById('profileLinksSection');
  document.getElementById('profileCardLinks').replaceChildren(...links.map(link=>{
    const a=document.createElement('a');a.className='profile-card-link';a.href=link.url;a.target='_blank';a.rel='noopener noreferrer';
    const mark=document.createElement('b');mark.textContent='↗';const label=document.createElement('span');label.textContent=link.label||new URL(link.url).hostname;a.append(mark,label);return a;
  }));
  linksSection.hidden=!links.length;
  const memberSince=document.getElementById('profileMemberSinceSection');
  if(profile.joinedAt){const joined=new Date(profile.joinedAt);document.getElementById('profileMemberSince').textContent=Number.isNaN(joined.getTime())?'':joined.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});memberSince.hidden=Number.isNaN(joined.getTime())}
  else memberSince.hidden=true;
  const mutualCount=Number(profile.mutualServerCount)||0;
  document.getElementById('profileMutualSection').hidden=mutualCount<1;
  document.getElementById('profileMutualCount').textContent=`${mutualCount} mutual server${mutualCount===1?'':'s'}`;
  const note=document.getElementById('profileCardNote');
  const noteOwner=callState.user?.id||'guest',noteTarget=profile.id||profile.username||'unknown',noteKey=`canopy-profile-note:${noteOwner}:${noteTarget}`;
  try{note.value=localStorage.getItem(noteKey)||''}catch{note.value=''}
  note.oninput=()=>{try{if(note.value)localStorage.setItem(noteKey,note.value);else localStorage.removeItem(noteKey)}catch{}}
  shade.classList.add('open');
  loadProfileRoleControls(profile,shade);
  card.style.left = '12px'; card.style.top = '12px'; card.style.right = 'auto'; card.style.bottom = 'auto';
  requestAnimationFrame(() => {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const bounds = card.getBoundingClientRect();
    const gap = 10, edge = 12;
    const rightSpace = window.innerWidth - rect.right - edge;
    const leftSpace = rect.left - edge;
    let left;
    if (rightSpace >= bounds.width + gap) left = rect.right + gap;
    else if (leftSpace >= bounds.width + gap) left = rect.left - bounds.width - gap;
    else left = Math.max(edge, Math.min(window.innerWidth - bounds.width - edge, rect.right + gap));
    const preferredTop = rect.top < window.innerHeight / 2 ? rect.top : rect.bottom - bounds.height;
    const top = Math.max(edge, Math.min(window.innerHeight - bounds.height - edge, preferredTop));
    card.style.left = `${left}px`; card.style.top = `${top}px`;
  });
}

async function openProfileSettings(initialPage = 'My Profile') {
  document.getElementById('profileCardShade').classList.remove('open');
  const shade = document.getElementById('settingsShade');
  const nav = document.getElementById('settingsNav');
  const panel = document.getElementById('settingsPanel');
  shade.classList.add('open');
  document.getElementById('serverMenu').classList.remove('open');
  nav.innerHTML = `<div class="settings-brand">USER SETTINGS</div><button data-user-page="My Account"${initialPage === 'My Account' ? ' class="selected"' : ''}>My Account</button><button data-user-page="My Profile"${initialPage === 'My Profile' ? ' class="selected"' : ''}>My Profile</button>`;
  panel.innerHTML = '<h1>My Profile</h1><p>Personalize how people see you across Canopy.</p><div class="setting-card">Loading your profile…</div>';
  try {
    const { profile } = await api('/api/profile');
    callState.profile = profile;
    const openPage = page => {
      nav.querySelectorAll('[data-user-page]').forEach(button => button.classList.toggle('selected', button.dataset.userPage === page));
      const currentProfile = callState.profile || profile;
      if (page === 'My Account') renderAccountOverview(currentProfile, openPage);
      else renderProfileEditor(currentProfile);
    };
    nav.querySelectorAll('[data-user-page]').forEach(button => button.onclick = () => openPage(button.dataset.userPage));
    openPage(initialPage);
  } catch (error) {
    panel.innerHTML = `<h1>My Profile</h1><p>${escapeText(error.message)}</p>`;
  }
}

function renderAccountOverview(profile, openPage) {
  const panel = document.getElementById('settingsPanel');
  const bannerStyle = profile.bannerData
    ? `background-image:url(&quot;${profile.bannerData}&quot;)`
    : `background-image:linear-gradient(120deg,${escapeText(profile.primaryColor || '#263743')},${escapeText(profile.accentColor || '#2eb9b4')})`;
  panel.innerHTML = `<h1>My Account</h1><p>Manage your account details and the profile people see across Canopy.</p>
    <section class="account-summary"><div class="account-summary-banner" style="${bannerStyle}"></div><div class="account-summary-body"><div class="avatar account-summary-avatar"></div><div class="account-summary-heading"><div><h2>${escapeText(profile.displayName || profile.username)}</h2><span>@${escapeText(profile.username || '')}${profile.pronouns ? ` · ${escapeText(profile.pronouns)}` : ''}</span></div><button type="button" class="action" data-edit-profile>Edit user profile</button></div>
    <div class="account-details"><div class="account-detail"><div><small>DISPLAY NAME</small><strong>${escapeText(profile.displayName || '')}</strong></div><button type="button" class="subtle" data-edit-profile>Edit</button></div>
    <div class="account-detail"><div><small>USERNAME</small><strong>@${escapeText(profile.username || '')}</strong></div><button type="button" class="subtle" data-edit-username>Edit</button></div>
    <div class="account-username-editor" id="accountUsernameEditor" hidden><label for="accountUsernameInput">NEW USERNAME</label><input id="accountUsernameInput" type="text" value="${escapeText(profile.username || '')}" minlength="3" maxlength="24" autocomplete="username" spellcheck="false" aria-describedby="accountUsernameFeedback"><p>Use 3–24 letters, numbers, or underscores.</p><div id="accountUsernameFeedback" role="status" class="auth-error"></div><div class="account-username-actions"><button type="button" class="action" data-save-username>Save username</button><button type="button" class="subtle" data-cancel-username>Cancel</button></div></div>
    <div class="account-detail"><div><small>EMAIL</small><strong>${escapeText(profile.email || 'Email on file')}</strong></div></div></div></div></section>
    <h2 class="account-section-label">PROFILE CUSTOMIZATION</h2><p>Update your photo, banner, about me, theme, avatar decoration, and frame.</p><button type="button" class="action" data-edit-profile>Open profile editor</button>`;
  applyAvatar(panel.querySelector('.account-summary-avatar'), profile);
  panel.querySelectorAll('[data-edit-profile]').forEach(button => button.onclick = () => {
    openPage('My Profile');
    requestAnimationFrame(() => document.getElementById('profileDisplayName')?.focus());
  });
  const usernameEditor = panel.querySelector('#accountUsernameEditor');
  const usernameInput = panel.querySelector('#accountUsernameInput');
  const usernameFeedback = panel.querySelector('#accountUsernameFeedback');
  panel.querySelector('[data-edit-username]').onclick = () => {
    usernameEditor.hidden = false;
    usernameFeedback.textContent = '';
    usernameInput.focus();
    usernameInput.select();
  };
  panel.querySelector('[data-cancel-username]').onclick = () => { usernameEditor.hidden = true; usernameFeedback.textContent = ''; };
  const saveUsername = async () => {
    const username = usernameInput.value.trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      usernameFeedback.textContent = 'Username must be 3–24 characters and use only letters, numbers, or underscores.';
      usernameInput.focus();
      return;
    }
    const saveButton = panel.querySelector('[data-save-username]');
    saveButton.disabled = true;
    usernameFeedback.textContent = 'Saving…';
    try {
      const result = await api('/api/account', { method: 'PATCH', body: JSON.stringify({ username }) });
      callState.profile = result.profile;
      callState.user = { ...callState.user, username: result.profile.username, displayName: result.profile.displayName };
      renderAccountOverview(result.profile, openPage);
      notify('Username updated');
    } catch (error) {
      usernameFeedback.textContent = error.message;
      saveButton.disabled = false;
    }
  };
  panel.querySelector('[data-save-username]').onclick = saveUsername;
  usernameInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); saveUsername(); } };
}

function renderProfileEditor(profile) {
  const panel = document.getElementById('settingsPanel');
  const linkValues = Array.isArray(profile.links) ? profile.links : [];
  const savedTheme = String(profile.theme || 'Midnight');
  const selectedTheme = profileThemes.find(theme => theme.name.toLowerCase() === savedTheme.toLowerCase())?.name || (savedTheme.toLowerCase() === 'custom' ? 'Custom' : 'Midnight');
  const themeButtons = profileThemes.map(theme => `<button type="button" class="profile-choice${selectedTheme === theme.name ? ' selected' : ''}" data-theme="${theme.name}"><span class="profile-choice-color" style="background:linear-gradient(90deg,${theme.primary},${theme.accent})"></span>${theme.name}</button>`).join('') + `<button type="button" class="profile-choice${selectedTheme === 'Custom' ? ' selected' : ''}" data-theme="Custom"><span class="profile-choice-color" style="background:linear-gradient(90deg,${profile.primaryColor || '#263743'},${profile.accentColor || '#2eb9b4'})"></span>Custom</button>`;
  const decorationButtons = profileDecorations.map(name => {
    const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const legacyIcon = ({ Flames:'🔥', Crown:'👑', Halo:'😇', Horns:'😈', 'Cat ears':'🐱', Wings:'🪽', Headphones:'🎧' })[name];
    const sample = legacyIcon ? `<span class="decor-legacy-icon">${legacyIcon}</span>` : '<span class="decor-sample-avatar">C</span>';
    return `<button type="button" aria-label="${name} avatar decoration" class="profile-choice decor-choice${profile.decoration === name ? ' selected' : ''}" data-decoration="${name}"><span class="decor-preview decoration-${slug}${name === 'None' ? ' decor-none' : ''}">${sample}</span><span class="decor-label">${name}</span></button>`;
  }).join('');
  const frameButtons = profileFrames.map(name => `<button type="button" class="profile-choice${profile.frame === name ? ' selected' : ''}" data-frame="${name}">${name === 'None' ? '◯' : '✦'}<br>${name}</button>`).join('');
  panel.innerHTML = `<h1>My Profile</h1><p>Personalize how people see you across Canopy.</p>
    <div class="profile-editor"><form id="profileForm">
      <label class="profile-field">DISPLAY NAME<input id="profileDisplayName" maxlength="32" required value="${escapeText(profile.displayName)}"></label>
      <label class="profile-field">PRONOUNS<input id="profilePronouns" maxlength="32" placeholder="e.g. they/them" value="${escapeText(profile.pronouns || '')}"></label>
      <h2>PROFILE PICTURE</h2><p>Upload a square image for your avatar. PNG, JPEG, WebP, or GIF · up to 1 MB.</p>
      <div class="profile-upload"><input id="profileAvatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="action" id="chooseAvatar">Upload picture</button><button type="button" class="subtle" id="removeAvatar">Remove</button></div>
      <h2>BANNER</h2><p>A wide image at the top of your profile card · up to 2 MB.</p>
      <div class="profile-upload"><input id="profileBannerFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><button type="button" class="action" id="chooseBanner">Upload banner</button><button type="button" class="subtle" id="removeBanner">Remove</button></div>
      <label class="profile-field">ABOUT ME<textarea id="profileAbout" maxlength="120" placeholder="A little about you…">${escapeText(profile.aboutMe || '')}</textarea><small id="aboutCount"></small></label>
      <h2>PROFILE THEME</h2><div class="profile-choice-grid" id="themeChoices">${themeButtons}</div>
      <h2>CUSTOM THEME COLORS</h2><p>Choose the two colors on your profile card.</p><div class="profile-upload"><label>Primary <input id="profilePrimaryColor" type="color" value="${escapeText(profile.primaryColor)}"></label><label>Accent <input id="profileAccentColor" type="color" value="${escapeText(profile.accentColor)}"></label></div>
      <h2>AVATAR DECORATION</h2><div class="profile-choice-grid" id="decorationChoices">${decorationButtons}</div>
      <h2>AVATAR FRAME</h2><div class="profile-choice-grid" id="frameChoices">${frameButtons}</div>
      <h2>LINKS</h2><p>Add up to 5 links to your profile.</p><div id="profileLinks"></div><div class="profile-upload"><input id="profileLinkLabel" maxlength="32" placeholder="Link label"><input id="profileLinkUrl" type="url" placeholder="https://example.com"><button type="button" class="subtle" id="addProfileLink">＋ Add link</button></div>
      <div id="profileFeedback" role="status" class="auth-error"></div><div class="profile-savebar"><span>Save when you’re happy with your profile</span><button class="action" type="submit">Save changes</button></div>
    </form><aside><div class="profile-preview" id="profilePreview"><div class="profile-preview-banner" id="profilePreviewBanner"></div><div class="avatar profile-preview-avatar" id="profilePreviewAvatar"></div><h2 class="profile-preview-name" id="profilePreviewName"></h2><div class="profile-preview-handle" id="profilePreviewHandle"></div><div class="profile-preview-about" id="profilePreviewAbout"></div><div id="profilePreviewLinks"></div></div></aside></div>`;
  let avatarData = profile.avatarData || '';
  let bannerData = profile.bannerData || '';
  let links = linkValues.map(link => ({ label: link.label, url: link.url }));
  const themeInput = document.getElementById('profileForm');
  themeInput.dataset.theme = selectedTheme;
  themeInput.dataset.decoration = profile.decoration || 'None';
  themeInput.dataset.frame = profile.frame || 'None';
  const $ = id => document.getElementById(id);
  const renderLinks = () => {
    $('profileLinks').innerHTML = links.map((link, i) => `<div class="profile-link-row"><a href="${escapeText(link.url)}" target="_blank" rel="noopener noreferrer">${escapeText(link.label || link.url)}</a><button type="button" class="subtle" data-remove-link="${i}">Remove</button></div>`).join('') || '<p>No links added yet.</p>';
    $('profilePreviewLinks').innerHTML = links.map(link => `<a class="pill" href="${escapeText(link.url)}" target="_blank" rel="noopener noreferrer">${escapeText(link.label || link.url)}</a>`).join('');
    $('profileLinks').querySelectorAll('[data-remove-link]').forEach(button => button.onclick = () => { links.splice(Number(button.dataset.removeLink), 1); renderLinks(); });
  };
  const updatePreview = () => {
    const preview = $('profilePreview');
    preview.style.background = `linear-gradient(145deg,${$('profilePrimaryColor').value},${$('profileAccentColor').value})`;
    $('profilePreviewBanner').style.backgroundImage = bannerData ? `url("${bannerData}")` : `linear-gradient(135deg,${$('profilePrimaryColor').value},${$('profileAccentColor').value})`;
    $('profilePreviewAvatar').style.borderColor = $('profilePreview').style.backgroundColor || '#1b1e2a';
    $('profilePreviewName').textContent = $('profileDisplayName').value || 'Your name';
    $('profilePreviewHandle').textContent = `@${profile.username}${$('profilePronouns').value ? ' · '+$('profilePronouns').value : ''}`;
    $('profilePreviewAbout').textContent = $('profileAbout').value || 'Your about me will appear here.';
    $('aboutCount').textContent = `${$('profileAbout').value.length}/120`;
    applyAvatar($('profilePreviewAvatar'), { displayName: $('profileDisplayName').value, avatarData, decoration: themeInput.dataset.decoration, frame: themeInput.dataset.frame });
  };
  const readImage = (file, maxBytes) => new Promise((resolve, reject) => {
    if (file.size > maxBytes) return reject(new Error(`Choose an image under ${Math.round(maxBytes / 1024 / 1024)} MB.`));
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read that image.')); reader.readAsDataURL(file);
  });
  const setImage = (inputId, kind) => $(inputId).addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const image = await readImage(file, kind === 'avatar' ? 1024 * 1024 : 2 * 1024 * 1024); if (kind === 'avatar') avatarData = image; else bannerData = image; updatePreview(); }
    catch (error) { $('profileFeedback').textContent = error.message; }
  });
  $('chooseAvatar').onclick = () => $('profileAvatarFile').click(); $('chooseBanner').onclick = () => $('profileBannerFile').click();
  $('removeAvatar').onclick = () => { avatarData = ''; $('profileAvatarFile').value = ''; updatePreview(); };
  $('removeBanner').onclick = () => { bannerData = ''; $('profileBannerFile').value = ''; updatePreview(); };
  setImage('profileAvatarFile', 'avatar'); setImage('profileBannerFile', 'banner');
  $('themeChoices').querySelectorAll('[data-theme]').forEach(button => button.onclick = () => {
    themeInput.dataset.theme = button.dataset.theme;
    const theme = profileThemes.find(item => item.name === button.dataset.theme); if (theme) { $('profilePrimaryColor').value = theme.primary; $('profileAccentColor').value = theme.accent; }
    $('themeChoices').querySelectorAll('[data-theme]').forEach(item => item.classList.toggle('selected', item === button)); updatePreview();
  });
  $('profilePrimaryColor').oninput = $('profileAccentColor').oninput = () => { themeInput.dataset.theme = 'Custom'; $('themeChoices').querySelectorAll('[data-theme]').forEach(item => item.classList.toggle('selected', item.dataset.theme === 'Custom')); const swatch = $('themeChoices').querySelector('[data-theme="Custom"] .profile-choice-color'); swatch.style.background = `linear-gradient(90deg,${$('profilePrimaryColor').value},${$('profileAccentColor').value})`; updatePreview(); };
  $('decorationChoices').querySelectorAll('[data-decoration]').forEach(button => button.onclick = () => { themeInput.dataset.decoration = button.dataset.decoration; $('decorationChoices').querySelectorAll('[data-decoration]').forEach(item => item.classList.toggle('selected', item === button)); updatePreview(); });
  $('frameChoices').querySelectorAll('[data-frame]').forEach(button => button.onclick = () => { themeInput.dataset.frame = button.dataset.frame; $('frameChoices').querySelectorAll('[data-frame]').forEach(item => item.classList.toggle('selected', item === button)); updatePreview(); });
  for (const id of ['profileDisplayName', 'profilePronouns', 'profileAbout']) $(id).addEventListener('input', updatePreview);
  $('addProfileLink').onclick = () => {
    const raw = $('profileLinkUrl').value.trim();
    try {
      const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      if (links.length >= 5) throw new Error('You can add up to 5 links.');
      links.push({ label: $('profileLinkLabel').value.trim() || url.hostname, url: url.href }); $('profileLinkLabel').value = ''; $('profileLinkUrl').value = ''; renderLinks(); updatePreview();
    } catch { $('profileFeedback').textContent = links.length >= 5 ? 'You can add up to 5 links.' : 'Enter a valid http or https link.'; }
  };
  renderLinks(); updatePreview();
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault(); $('profileFeedback').textContent = 'Saving…';
    try {
      const result = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({
        displayName: $('profileDisplayName').value, pronouns: $('profilePronouns').value, aboutMe: $('profileAbout').value,
        avatarData, bannerData, theme: themeInput.dataset.theme,
        primaryColor: $('profilePrimaryColor').value, accentColor: $('profileAccentColor').value,
        decoration: themeInput.dataset.decoration, frame: themeInput.dataset.frame, links
      }) });
      callState.profile = result.profile; callState.user = { ...callState.user, displayName: result.profile.displayName };
      document.getElementById('currentUsername').textContent = result.profile.displayName; applyAvatar(document.getElementById('currentAvatar'), result.profile);
      $('profileFeedback').textContent = 'Profile saved.'; notify('Profile updated');
    } catch (error) { $('profileFeedback').textContent = error.message; }
  });
}

async function loadServers() {
  const result = await api('/api/servers');
  callState.servers = result.servers;
  const joined = result.servers.filter(server => server.joined);
  const defaultServer = joined.find(server => server.id === 'yapper-commons') || joined[0];
  const fixed = document.querySelector('.servers > .server[title="Canopy"]');
  const host = document.getElementById('serverList');
  host.innerHTML = '';
  if (fixed && defaultServer) {
    fixed.title = defaultServer.name;
    fixed.dataset.roomId = defaultServer.id;
    fixed.dataset.fixedServer = 'true';
    fixed.innerHTML = defaultServer.iconData ? `<img src="${defaultServer.iconData}" alt="">` : escapeText(defaultServer.name.slice(0, 2).toUpperCase());
  }
  joined.filter(server => server.id !== defaultServer?.id).forEach((server, i) => {
    const button = document.createElement('button'); button.className = 'server custom-server'; button.dataset.roomId = server.id; button.dataset.serverIndex = String(i); button.title = server.name;
    button.style.background = ['#6377e8','#2c9c81','#bc7050','#8c64cf'][i % 4]; button.innerHTML = server.iconData ? `<img src="${server.iconData}" alt="">` : escapeText(server.name.slice(0, 2).toUpperCase()); host.append(button);
  });
  callState.selectedServer = defaultServer || null;
  if (defaultServer) selectServerUI(defaultServer);
}

function selectServerUI(server) {
  window.showCommunityView?.();
  callState.selectedServer = server;
  document.querySelectorAll('.servers .server').forEach(button => button.classList.toggle('active', button.dataset.roomId === server.id));
  document.querySelector('#serverHead>span:first-child').textContent = server.name;
  document.getElementById('channelTitle').textContent = 'general';
  document.querySelector('.topic').textContent = server.about || server.focus || '';
  const banner = document.querySelector('.channel-scroll > div:first-child');
  if (banner) { banner.textContent = server.name.toUpperCase(); banner.style.backgroundImage = server.bannerData ? `url("${server.bannerData}")` : ''; banner.classList.add('server-banner-strip'); }
  document.getElementById('messageInput').placeholder = 'Message #general';
  document.querySelectorAll('#composer button,#messageInput').forEach(control=>control.disabled=false);
  callState.currentChannel = 'general';
  document.querySelectorAll('.channel[data-channel]').forEach(channel => channel.classList.toggle('active', channel.dataset.channel === 'general'));
  document.getElementById('channelTitle').textContent = 'general';
  callState.currentRoom = server.id;
  renderMembers([]);
  loadServerChannels(server.id);
  syncTicketMenu(server);
  api(`/api/servers/${server.id}/emojis`).then(({emojis})=>{if(callState.selectedServer?.id===server.id)callState.serverEmojis=new Map(emojis.map(emoji=>[emoji.name.toLowerCase(),emoji.imageData]))}).catch(()=>{if(callState.selectedServer?.id===server.id)callState.serverEmojis=new Map()});
}

const serverContextMenu=document.getElementById('serverContextMenu');
function mutedServerIds(){try{return new Set(JSON.parse(localStorage.getItem('canopy-muted-servers')||'[]'))}catch{return new Set()}}
function closeServerContextMenu(){serverContextMenu.hidden=true;serverContextMenu.dataset.serverId=''}
document.addEventListener('contextmenu',event=>{
  const button=event.target.closest('.servers .server[data-room-id]');if(!button)return;
  const server=callState.servers.find(item=>item.id===button.dataset.roomId);if(!server)return;
  event.preventDefault();serverContextMenu.dataset.serverId=server.id;
  serverContextMenu.querySelector('[data-server-menu-action="mute"]').textContent=mutedServerIds().has(server.id)?'Unmute server':'Mute server';
  const leave=serverContextMenu.querySelector('[data-server-menu-action="leave"]');leave.disabled=server.ownerUserId===callState.user?.id;leave.title=leave.disabled?'Transfer ownership before leaving this server':'';
  serverContextMenu.hidden=false;serverContextMenu.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-190))}px`;serverContextMenu.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-180))}px`;
},true);
document.addEventListener('click',async event=>{
  const action=event.target.closest('#serverContextMenu [data-server-menu-action]');
  if(!action){if(!event.target.closest('#serverContextMenu'))closeServerContextMenu();return}
  event.preventDefault();event.stopImmediatePropagation();const id=serverContextMenu.dataset.serverId,server=callState.servers.find(item=>item.id===id);if(!server)return;
  const type=action.dataset.serverMenuAction;closeServerContextMenu();
  if(type==='invite'){
    try{selectServerUI(server);await setRoom(server.id);window.realtimeChat?.openCommunity('invite')}catch(error){notify(error.message)}
  }else if(type==='mute'){
    const ids=mutedServerIds();if(ids.has(id))ids.delete(id);else ids.add(id);localStorage.setItem('canopy-muted-servers',JSON.stringify([...ids]));notify(ids.has(id)?'Server muted':'Server unmuted');
  }else if(type==='copy'){
    try{await navigator.clipboard.writeText(id);notify('Server ID copied')}catch{notify(`Server ID: ${id}`)}
  }else if(type==='leave'){
    if(!confirm(`Leave ${server.name}? You can rejoin with an invite.`))return;
    try{await api(`/api/servers/${id}/leave`,{method:'POST',body:'{}'});await loadServers();if(callState.selectedServer)await setRoom(callState.selectedServer.id);else window.showDirectMessages?.();notify(`Left ${server.name}`)}catch(error){notify(error.message)}
  }
},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeServerContextMenu()});

async function syncTicketMenu(server) {
  const menu=document.getElementById('serverMenu'); menu.querySelector('[data-server-action="ticket"]')?.remove();
  try {
    const {settings}=await api(`/api/servers/${server.id}/settings`);
    if(!settings.ticketsEnabled)return;
    const mine=(await api(`/api/servers/${server.id}/tickets/mine`)).ticket;
    const button=document.createElement('button');button.dataset.serverAction='ticket';button.textContent=mine?'View my support ticket　✉':'Open a support ticket　✉';
    menu.insertBefore(button,menu.querySelector('[data-setting]'));
    button.onclick=async()=>{try{if(mine){openTicketConversation(server,mine);return}const title=prompt('What do you need help with?');if(title===null)return;const details=prompt('Add details for the moderators:')??'';const result=await api(`/api/servers/${server.id}/tickets`,{method:'POST',body:JSON.stringify({title,details})});openTicketConversation(server,{...result.ticket,title,details});}catch(error){notify(error.message)}};
  }catch{}
}

async function openTicketConversation(server,ticket){
  const shade=document.getElementById('communityShade'),title=document.getElementById('communityTitle'),subtitle=document.getElementById('communitySubtitle'),body=document.getElementById('communityBody');
  title.textContent=ticket.title;subtitle.textContent=`Private support conversation · ${server.name}`;shade.classList.add('open');body.innerHTML='<div class="setting-card" id="ticketConversationMessages">Loading…</div><form id="ticketReplyForm" class="setting-card"><label>REPLY</label><textarea name="text" maxlength="2000" required placeholder="Write a reply for the moderators"></textarea><div class="community-actions"><button type="button" class="subtle" id="closeTicketView">Close</button><button class="action">Send reply</button></div></form>';
  const refresh=async()=>{const {messages}=await api(`/api/servers/${server.id}/tickets/${ticket.id}/messages`);const host=body.querySelector('#ticketConversationMessages');host.replaceChildren();if(ticket.details){const initial=document.createElement('p');initial.className='ticket-message';const author=document.createElement('strong');author.textContent=ticket.username||'Original request';const content=document.createElement('span');content.textContent=ticket.details;initial.append(author,content);host.append(initial)}for(const message of messages){const item=document.createElement('p');item.className='ticket-message';const author=document.createElement('strong');author.textContent=message.displayName;const content=document.createElement('span');content.textContent=message.text;const time=document.createElement('small');time.textContent=new Date(message.sentAt).toLocaleString();item.append(author,content,time);host.append(item)}};
  await refresh();if(ticket.status==='closed')body.querySelector('#ticketReplyForm textarea').disabled=true;body.querySelector('#closeTicketView').onclick=()=>shade.classList.remove('open');body.querySelector('#ticketReplyForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"],button:not([type])');button.disabled=true;try{await api(`/api/servers/${server.id}/tickets/${ticket.id}/messages`,{method:'POST',body:JSON.stringify({text:form.elements.text.value})});form.reset();await refresh()}catch(error){notify(error.message)}finally{button.disabled=false}};
}

function renderInviteCode(body, shade, code) {
  const inviteUrl = `${location.origin}/invite/${encodeURIComponent(code)}`;
  body.innerHTML = `<div class="setting-card"><label for="serverInviteCode">SERVER INVITE LINK</label><input id="serverInviteCode" readonly value="${escapeText(inviteUrl)}"><p>Anyone with this link and a Canopy account can join this community.</p><div class="community-actions"><button type="button" class="subtle" id="closeInviteCode">Done</button><button type="button" class="action" id="copyInviteCode">Copy invite link</button></div></div>`;
  body.querySelector('#copyInviteCode').onclick = async () => {
    try { await navigator.clipboard.writeText(inviteUrl); notify('Invite link copied'); }
    catch { const input = body.querySelector('#serverInviteCode'); input.select(); document.execCommand('copy'); notify('Invite link copied'); }
  };
  body.querySelector('#closeInviteCode').onclick = () => shade.classList.remove('open');
}

async function openCommunity(mode) {
  const shade = document.getElementById('communityShade');
  const title = document.getElementById('communityTitle');
  const subtitle = document.getElementById('communitySubtitle');
  const body = document.getElementById('communityBody');
  shade.classList.add('open');
  document.getElementById('serverMenu').classList.remove('open');
  if (mode === 'create') {
    title.textContent = 'Create a server'; subtitle.textContent = 'Start a real community for people to meet and share ideas.';
    body.innerHTML = '<form id="createServerForm"><label>SERVER NAME</label><input id="newServerName" maxlength="42" required placeholder="Creative Coffee Meetup"><label>WHAT IS THIS COMMUNITY ABOUT?</label><textarea id="newServerAbout" maxlength="180" placeholder="A place for local creatives to meet, share work, and grow their network."></textarea><label>COMMUNITY FOCUS</label><select id="newServerType"><option>Meetups & events</option><option>Professional networking</option><option>Creative community</option><option>Local community</option><option>Hobbies & interests</option></select><label>WHO CAN JOIN?</label><select id="newServerVisibility"><option value="Public">Public · discoverable by signed-in members</option><option value="Invite only">Invite only</option></select><div class="community-actions"><button type="button" class="subtle" id="cancelCommunity">Cancel</button><button class="action">Create server</button></div><p class="auth-error" id="communityError"></p></form>';
    document.getElementById('cancelCommunity').onclick = () => shade.classList.remove('open');
    document.getElementById('createServerForm').onsubmit = async event => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('button[type="submit"],button:not([type])');
      submit.disabled = true;
      try {
        const result = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newServerName').value, about: document.getElementById('newServerAbout').value, focus: document.getElementById('newServerType').value, visibility: document.getElementById('newServerVisibility').value }) });
        await loadServers(); selectServerUI(result.server); await setRoom(result.server.id);
        if (result.inviteCode) {
          title.textContent = 'Your private server is ready';
          subtitle.textContent = 'Share this invite code with the people you want to join.';
          renderInviteCode(body, shade, result.inviteCode);
        } else shade.classList.remove('open');
      } catch (error) { document.getElementById('communityError').textContent = error.message; submit.disabled = false; }
    };
    return;
  }
  if (mode === 'invite') {
    title.textContent = 'Invite people';
    subtitle.textContent = 'Share a code so other members can join this community.';
    body.innerHTML = '<div class="setting-card">Creating an invite code…</div>';
    try {
      if (!callState.selectedServer) throw new Error('Select a community before inviting people.');
      const result = await api(`/api/servers/${callState.selectedServer.id}/invite`, { method: 'POST', body: '{}' });
      renderInviteCode(body, shade, result.inviteCode);
    } catch (error) { body.innerHTML = `<div class="setting-card">${escapeText(error.message)}</div>`; }
    return;
  }
  title.textContent = 'Explore communities'; subtitle.textContent = 'Join a real server created by another member.';
  try {
    const { servers } = await api('/api/servers');
    const discoverable = servers.filter(server => !server.joined && server.visibility === 'Public');
    const inviteForm = '<form id="joinInviteForm" class="invite-join-form"><label for="communityInviteCode">HAVE AN INVITE LINK OR CODE?</label><div><input id="communityInviteCode" maxlength="300" placeholder="Paste an invite link or code" required><button class="action" type="submit">Join with invite</button></div><p id="inviteJoinFeedback" class="auth-error" role="status"></p></form>';
    if (!discoverable.length) { body.innerHTML = inviteForm + '<div class="setting-card"><h2>No public communities yet</h2><p>When another member creates a public server, it will appear here. You can create one with the + button, or join a private community with an invite code.</p></div>'; }
    else body.innerHTML = inviteForm + '<div class="discover-grid">'+discoverable.map((server, i) => `<article class="discover-card"><div class="discover-icon">${['☕','🌆','🥾','💡'][i%4]}</div><h3>${escapeText(server.name)}</h3><div><span class="community-tag">${escapeText(server.focus)}</span></div><p>${escapeText(server.about)}</p><div class="discover-meta">${server.memberCount} account members · ${server.onlineCount} online</div><button class="action join-community" data-server="${server.id}">Join community</button></article>`).join('')+'</div>';
    body.querySelector('#joinInviteForm').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector('button[type="submit"]'), feedback = form.querySelector('#inviteJoinFeedback');
      button.disabled = true; feedback.textContent = 'Joining…';
      try {
        let code = form.querySelector('#communityInviteCode').value.trim();
        if(/^https?:\/\//i.test(code)){const inviteUrl=new URL(code);const match=inviteUrl.pathname.match(/\/invite\/([a-z0-9-]{3,24})$/i);if(!match)throw new Error('That invite link is not valid.');code=match[1];}
        else code=code.replace(/^\/invite\//i,'').trim();
        const result = await api(`/api/invites/${encodeURIComponent(code)}/join`, { method: 'POST', body: '{}' });
        await loadServers();
        const joined = callState.servers.find(server => server.id === result.serverId);
        if (!joined) throw new Error('Joined, but the server could not be loaded. Refresh and try again.');
        selectServerUI(joined); await setRoom(joined.id); shade.classList.remove('open');
      } catch (error) { feedback.textContent = error.message; button.disabled = false; }
    };
    body.querySelectorAll('.join-community').forEach(button => button.onclick = async () => { try { await api(`/api/servers/${button.dataset.server}/join`, { method: 'POST', body: '{}' }); await loadServers(); const joined = callState.servers.find(server => server.id === button.dataset.server); selectServerUI(joined); await setRoom(joined.id); shade.classList.remove('open'); } catch (error) { subtitle.textContent = error.message; } });
    if(callState.pendingInviteToken){const input=body.querySelector('#communityInviteCode');if(input){input.value=callState.pendingInviteToken;callState.pendingInviteToken=null;setTimeout(()=>body.querySelector('#joinInviteForm')?.requestSubmit(),0)}}
  } catch (error) { body.textContent = error.message; }
}

function escapeText(text) { const element = document.createElement('span'); element.textContent = text || ''; return element.innerHTML; }

async function openApp(user) {
  callState.user = user;
  try { callState.profile = (await api('/api/profile')).profile; callState.user.displayName = callState.profile.displayName; }
  catch { callState.profile = { ...user, avatarData: '', decoration: 'None', frame: 'None' }; }
  document.getElementById('authGate').hidden = true;
  document.getElementById('app').classList.add('authenticated');
  document.getElementById('currentUsername').textContent = user.displayName;
  document.getElementById('currentUsername').textContent = callState.user.displayName;
  applyAvatar(document.getElementById('currentAvatar'), callState.profile);
  await loadServers();
  callState.autoReconnect = true;
  connect();
  callState.pendingInviteToken = new URLSearchParams(location.search).get('invite');
  if (callState.pendingInviteToken) { history.replaceState({}, '', '/'); setTimeout(() => openCommunity('explore'), 0); }
}

document.getElementById('loginTab').addEventListener('click', () => setAuthMode('login'));
document.getElementById('registerTab').addEventListener('click', () => setAuthMode('register'));
document.getElementById('userSettingsButton').addEventListener('click', () => openProfileSettings('My Account'));
document.getElementById('profileQuickButton').addEventListener('click', event => openProfileCard(undefined, event.currentTarget));
document.getElementById('profileCardEdit').addEventListener('click', openProfileSettings);
document.getElementById('profileCardClose').addEventListener('click', () => document.getElementById('profileCardShade').classList.remove('open'));
document.getElementById('profileCardShade').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.classList.remove('open');
});
document.getElementById('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = document.getElementById('authError'); error.textContent = '';
  const payload = { email: document.getElementById('emailInput').value, password: document.getElementById('passwordInput').value };
  try {
    const result = await api(authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(payload) });
    await openApp(result.user);
  } catch (err) { error.textContent = err.message; }
});
document.getElementById('logoutButton').addEventListener('click', async () => {
  callState.autoReconnect = false;
  await stopCall();
  callState.socket?.close(); callState.socket = null; callState.connected = false; callState.user = null;
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  document.getElementById('app').classList.remove('authenticated'); document.getElementById('authGate').hidden = false; setAuthMode('login');
});

api('/api/me').then(({ user }) => openApp(user)).catch(error => {
  document.getElementById('authGate').hidden = false;
  if (window.location.protocol === 'file:') document.getElementById('authError').textContent = error.message;
});

document.addEventListener('click', event => {
  const add = event.target.closest('.server.add');
  const explore = event.target.closest('.server.explore');
  if (add || explore) { event.preventDefault(); event.stopImmediatePropagation(); openCommunity(add ? 'create' : 'explore'); }
}, true);
document.addEventListener('submit', event => {
  if (event.target.id !== 'composer' || window.realtimeChat?.isOnline()) return;
  event.preventDefault(); event.stopImmediatePropagation();
  setStatus('Live server unavailable', 'Message not sent · connect to the live server first');
}, true);
document.addEventListener('click', event => {
  const createChannel=event.target.closest('[data-create-channel]');
  if(createChannel){event.preventDefault();event.stopImmediatePropagation();openServerSettings('Channels');return;}
  const button = event.target.closest('[data-room-id]');
  if (!button || !button.closest('#serverList')) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const server = callState.servers.find(item => item.id === button?.dataset.roomId);
  if (server) { selectServerUI(server); setRoom(server.id); }
}, true);
document.querySelector('.server[title="Canopy"]').addEventListener('click', event => {
  event.stopImmediatePropagation();
  const server = callState.servers.find(item => item.id === 'yapper-commons');
  if (server) { selectServerUI(server); setRoom(server.id); }
}, true);
document.getElementById('serverHead').addEventListener('click', event => {
  if (event.target.closest('[data-setting="Channels"]')) { event.preventDefault(); event.stopImmediatePropagation(); openServerSettings('Channels'); }
}, true);
document.addEventListener('click', event => {
  const menuItem=event.target.closest('#serverMenu [data-setting]');
  const navItem=event.target.closest('#settingsNav [data-page],#settingsNav [data-live-server-page]');
  if(menuItem){event.preventDefault();event.stopImmediatePropagation();openServerSettings(menuItem.dataset.setting);return;}
  if(navItem){event.preventDefault();event.stopImmediatePropagation();openServerSettings(navItem.dataset.liveServerPage||navItem.dataset.page);}
}, true);
document.addEventListener('click', event => {
  if (!event.target.closest('#settingsNav [data-page="Members"]')) return;
  event.preventDefault(); event.stopImmediatePropagation(); renderMemberSettings();
}, true);
document.addEventListener('click', event => {
  const channel = event.target.closest('.channel[data-channel]');
  if (!channel) return;
  event.preventDefault(); event.stopImmediatePropagation();
  document.querySelectorAll('.channel[data-channel]').forEach(item => item.classList.toggle('active', item === channel));
  const name = channel.dataset.channel;
  callState.currentChannel = name;
  document.getElementById('channelTitle').textContent = name;
  const blocked=channel.dataset.channelCanPost==='false',voice=channel.dataset.channelType==='voice',textOnly=channel.dataset.channelTextOnly==='true',canUpload=channel.dataset.channelCanUpload==='true';
  const input=document.getElementById('messageInput');input.placeholder=channel.dataset.channelTimedout?`Timed out until ${new Date(Number(channel.dataset.channelTimedout)).toLocaleString()}`:blocked?'You need an allowed role to post here':voice ? `Voice channel · ${name}` : `Message #${name}`;
  document.querySelectorAll('#composer button,#messageInput').forEach(control=>control.disabled=blocked||voice||(textOnly&&!canUpload&&control.matches('[data-media-tool]')));
  document.querySelector('.topic').textContent = ({ general: 'A place for this community to meet and talk.', introductions: 'Introduce yourself and the people you hope to meet.', events: 'Coordinate upcoming community meetups.', networking: 'Meet collaborators and share what you are working on.' })[name] || '';
  document.querySelector('.welcome h1').textContent = `Welcome to #${name}!`;
  document.querySelector('.welcome p').textContent = name === 'events' ? 'No meetups have been posted here yet.' : 'Start a conversation with your community.';
  messageList.innerHTML = '';
  messagesEl.scrollTop = 0;
  if (callState.selectedServer && callState.socket?.readyState === WebSocket.OPEN) setRoom(callState.selectedServer.id, name);
}, true);

function setStatus(text, live = text) {
  if (statusEl) statusEl.textContent = text;
  if (liveEl) liveEl.textContent = live;
}

function safeText(value) {
  return String(value ?? '');
}

function request(method, data = {}) {
  const socket = callState.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Live connection is offline.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      callState.pending.delete(id);
      reject(new Error('The server did not respond in time.'));
    }, 12000);
    callState.pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, data }));
  });
}

function appendMessage(message) {
  if (!messageList || !message?.text) return;
  const article = document.createElement('article');
  article.className = 'message';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.background = message.peerId === callState.peerId ? '#4b9d7a' : '#6377e8';
  const messageProfile = message.userId === callState.user?.id ? callState.profile : callState.roster.get(message.userId);
  avatar.textContent = safeText(message.userName).slice(0, 1).toUpperCase() || '?';
  applyAvatar(avatar, messageProfile || { displayName: message.userName });
  avatar.title = `View ${message.userName}'s profile`; avatar.style.cursor = 'pointer'; avatar.onclick = () => openProfileCard(messageProfile || { username: message.userName, displayName: message.userName, online: false }, avatar);
  const body = document.createElement('div');
  body.className = 'body';
  const author = document.createElement('span');
  author.className = 'author';
  if(message.userId)author.dataset.userId=message.userId;
  author.textContent = safeText(message.userName);
  if(messageProfile?.roleId&&/^#[0-9a-f]{6}$/i.test(messageProfile.roleColor||''))author.style.color=messageProfile.roleColor;
  author.title = `View ${message.userName}'s profile`; author.style.cursor = 'pointer'; author.onclick = () => openProfileCard(messageProfile || { username: message.userName, displayName: message.userName, online: false }, author);
  body.append(author);
  appendAccountBadges(body, message.badges || messageProfile?.badges);
  if(callState.selectedServer?.tag){const tag=document.createElement('span');tag.className='community-tag';tag.textContent=callState.selectedServer.tag;tag.title='Server tag';body.append(tag)}
  if (message.role === 'owner') { const badge = document.createElement('span'); badge.className = 'user-badge moderator'; badge.textContent = 'OWNER'; badge.title = 'Server owner'; body.append(badge); }
  else if(message.role&&message.role!=='member'){const badge=document.createElement('span');badge.className='community-tag';badge.textContent=message.role.toUpperCase();body.append(badge)}
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(message.sentAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const text = document.createElement('p');
  const messageText=safeText(message.text), tokenPattern=/\[\[media:([a-f0-9-]{36})\]\]|:([a-z0-9_]+):/gi;
  let cursor=0, token;
  while((token=tokenPattern.exec(messageText))){if(token.index>cursor)text.append(document.createTextNode(messageText.slice(cursor,token.index)));if(token[1]){const image=document.createElement('img');image.src=`/api/servers/${encodeURIComponent(callState.selectedServer?.id||'')}/attachments/${token[1]}`;image.alt='Shared image';image.className='message-attachment';image.loading='lazy';image.onerror=()=>image.remove();text.append(image)}else{const image=callState.serverEmojis.get(token[2].toLowerCase());if(image){const emoji=document.createElement('img');emoji.src=image;emoji.alt=`:${token[2]}:`;emoji.title=emoji.alt;emoji.className='inline-community-emoji';text.append(emoji)}else text.append(document.createTextNode(token[0]))}cursor=tokenPattern.lastIndex}
  if(cursor<messageText.length)text.append(document.createTextNode(messageText.slice(cursor)));
  body.append(time, text);
  if(message.userId && message.userId!==callState.user?.id && message.id && callState.selectedServer){
    const report=document.createElement('button');report.type='button';report.className='message-report';report.textContent='Report';report.title='Report this message';
    report.onclick=async()=>{const reason=prompt('Why are you reporting this message? (3–240 characters)');if(reason===null)return;try{await api(`/api/servers/${callState.selectedServer.id}/reports`,{method:'POST',body:JSON.stringify({messageId:message.id,reason})});notify('Report sent to this community’s moderators')}catch(error){notify(error.message)}};
    body.append(report);
  }
  article.append(avatar, body);
  messageList.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showRoster() {
  const online = new Set([...callState.onlineAccountIds, callState.user?.id].filter(Boolean));
  renderMembers([...callState.roster.values()].map(member => ({ ...member, online: online.has(member.id) })));
}

function renderRemote(peerId, peerName, track) {
  let entry = callState.peerMedia.get(peerId);
  if (!entry) {
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const label = document.createElement('span');
    label.className = 'call-label';
    label.textContent = peerName || 'Community member';
    tile.append(video, label);
    callStage.append(tile);
    entry = { tile, video, stream: new MediaStream() };
    video.srcObject = entry.stream;
    callState.peerMedia.set(peerId, entry);
    video.play().catch(() => {});
  }
  entry.stream.addTrack(track);
  entry.video.play().catch(() => {});
}

async function consumeProducer(info) {
  if (!callState.inCall || !callState.recvTransport || !callState.device || info.peerId === callState.peerId) {
    callState.queuedProducers.set(info.producerId, info);
    return;
  }
  if (callState.consumers.has(info.producerId)) return;
  try {
    const params = await request('consume', {
      transportId: callState.recvTransport.id,
      producerId: info.producerId,
      rtpCapabilities: callState.device.rtpCapabilities
    });
    const consumer = await callState.recvTransport.consume(params);
    callState.consumers.set(info.producerId, consumer);
    const peerName = callState.peerNames.get(info.peerId)?.name || 'Community member';
    renderRemote(info.peerId, peerName, consumer.track);
    await request('resumeConsumer', { consumerId: consumer.id });
    consumer.on('transportclose', () => callState.consumers.delete(info.producerId));
    consumer.on('producerclose', () => removeProducer(info.producerId, info.peerId));
    consumer.track.addEventListener('ended', () => removeProducer(info.producerId, info.peerId), { once: true });
  } catch (error) {
    console.warn('Unable to receive media:', error.message);
  }
}

function removeProducer(producerId, peerId) {
  const consumer = callState.consumers.get(producerId);
  const track = consumer?.track;
  consumer?.close();
  callState.consumers.delete(producerId);
  const entry = callState.peerMedia.get(peerId);
  if (entry) {
    if (track && entry.stream.getTracks().includes(track)) entry.stream.removeTrack(track);
    for (const track of [...entry.stream.getTracks()]) if (track.readyState === 'ended') entry.stream.removeTrack(track);
    if (!entry.stream.getTracks().length) {
      entry.tile.remove();
      callState.peerMedia.delete(peerId);
    }
  }
}

function handlePacket(packet) {
  if (packet.id && callState.pending.has(packet.id)) {
    const item = callState.pending.get(packet.id);
    clearTimeout(item.timeout);
    callState.pending.delete(packet.id);
    packet.error ? item.reject(new Error(packet.error)) : item.resolve(packet.result);
    return;
  }
  const { event, data } = packet;
  if (event === 'chatMessage') appendMessage(data);
  else if (event === 'peerJoined') {
    callState.peerNames.set(data.id, data);
    callState.onlineAccountIds.add(data.accountId);
    setStatus('Live · '+(data.name || 'member')+' joined', 'Live chat connected');
    showRoster();
  } else if (event === 'peerLeft') {
    const departing = callState.peerNames.get(data.peerId);
    callState.peerNames.delete(data.peerId);
    if (departing?.accountId) callState.onlineAccountIds.delete(departing.accountId);
    for (const [producerId, info] of callState.queuedProducers) if (info.peerId === data.peerId) callState.queuedProducers.delete(producerId);
    callState.peerMedia.get(data.peerId)?.tile.remove();
    callState.peerMedia.delete(data.peerId);
    showRoster();
    setStatus('Live · member left', 'Live chat connected');
  } else if (event === 'newProducer') consumeProducer(data);
  else if (event === 'producerClosed') removeProducer(data.producerId, data.peerId);
}

async function joinCurrentRoom() {
  if (!callState.socket || callState.socket.readyState !== WebSocket.OPEN) return;
  try {
    const joined = await request('joinRoom', { roomId: callState.currentRoom, channel: callState.currentChannel });
    callState.peerId = joined.peerId;
    callState.roster = new Map((joined.members || []).map(member => [member.id, member]));
    callState.peerNames = new Map((joined.peers || []).map(peer => [peer.id, peer]));
    callState.onlineAccountIds = new Set((joined.peers || []).map(peer => peer.accountId));
    renderMembers(joined.members || []);
    for (const message of joined.messages || []) appendMessage(message);
    showRoster();
    setStatus(`Live · ${joined.peers.length + 1} here`, 'Live chat connected · messages sync in this server');
    for (const producer of joined.producers || []) callState.queuedProducers.set(producer.producerId, producer);
  } catch (error) {
    setStatus('Server unavailable', 'Live server unavailable · start it with npm start');
  }
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${location.host}/ws`);
  callState.socket = socket;
  socket.addEventListener('open', async () => {
    callState.connected = true;
    callState.reconnectDelay = 500;
    await joinCurrentRoom();
  });
  socket.addEventListener('message', event => {
    try { handlePacket(JSON.parse(event.data)); } catch (error) { console.warn('Invalid server packet:', error); }
  });
  socket.addEventListener('close', () => {
    callState.connected = false;
    for (const pending of callState.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('Live connection closed.')); }
    callState.pending.clear();
    if (!callState.autoReconnect) return;
    setStatus('Reconnecting…', 'Live chat disconnected · reconnecting');
    setTimeout(() => { if (callState.autoReconnect && callState.user) connect(); }, callState.reconnectDelay);
    callState.reconnectDelay = Math.min(callState.reconnectDelay * 1.8, 10000);
  });
  socket.addEventListener('error', () => setStatus('Connecting…', 'Waiting for the live server'));
}

async function setRoom(roomId, channel = callState.currentChannel) {
  callState.currentRoom = roomId || 'yapper-commons';
  callState.currentChannel = channel || 'general';
  if (callState.inCall) await stopCall();
  if (callState.socket?.readyState === WebSocket.OPEN) {
    messageList.innerHTML = '';
    callState.peerNames.clear();
    callState.onlineAccountIds.clear();
    await joinCurrentRoom();
  }
}

async function createClientTransport(direction) {
  const options = await request('createWebRtcTransport', { direction });
  const transport = direction === 'send' ? callState.device.createSendTransport(options) : callState.device.createRecvTransport(options);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectTransport', { transportId: transport.id, dtlsParameters }).then(callback).catch(errback);
  });
  if (direction === 'send') {
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      request('produce', { transportId: transport.id, kind, rtpParameters, appData }).then(({ id }) => callback({ id })).catch(errback);
    });
  }
  transport.on('connectionstatechange', state => {
    if (state === 'failed') setStatus('Call connection failed', 'Check the server UDP port range and network setup');
  });
  return transport;
}

async function startCall(videoEnabled) {
  if (!callState.connected || !callState.peerId) {
    setStatus('Server unavailable', 'Start the signaling server before joining a call');
    return;
  }
  if (callState.inCall) return stopCall();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Media needs localhost or HTTPS', 'WebRTC requires a secure browser context');
    return;
  }
  try {
    callState.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: videoEnabled ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } } : false });
    callState.device ||= new Device();
    if (!callState.device.loaded) {
      const caps = await request('getRouterRtpCapabilities');
      await callState.device.load({ routerRtpCapabilities: caps });
    }
    callState.sendTransport = await createClientTransport('send');
    callState.recvTransport = await createClientTransport('recv');
    callState.inCall = true;
    callStage.classList.add('active');
    const localTile = document.createElement('div');
    localTile.className = 'call-tile';
    if (videoEnabled) {
      const localVideo = document.createElement('video');
      localVideo.autoplay = true; localVideo.playsInline = true; localVideo.muted = true; localVideo.srcObject = callState.stream;
      localTile.append(localVideo);
    } else localTile.textContent = '🎙';
    const localLabel = document.createElement('span'); localLabel.className = 'call-label'; localLabel.textContent = 'You'; localTile.append(localLabel); callStage.prepend(localTile);
    for (const track of callState.stream.getTracks()) {
      const producer = await callState.sendTransport.produce({ track, appData: { source: track.kind === 'video' ? 'camera' : 'microphone' } });
      callState.producers.set(producer.id, producer);
    }
    const queued = [...callState.queuedProducers.values()];
    callState.queuedProducers.clear();
    for (const producer of queued) await consumeProducer(producer);
    sendButton.textContent = '■'; videoButton.textContent = '■';
    setStatus(videoEnabled ? 'In video call' : 'In voice call', 'Call connected · media is forwarded by the SFU');
  } catch (error) {
    await stopCall();
    setStatus('Could not join call', error.message || 'Check microphone and camera permissions');
    console.error('Call setup failed:', error);
  }
}

async function stopCall() {
  for (const producer of callState.producers.values()) producer.close();
  callState.producers.clear();
  for (const consumer of callState.consumers.values()) consumer.close();
  callState.consumers.clear();
  callState.sendTransport?.close(); callState.recvTransport?.close();
  callState.sendTransport = null; callState.recvTransport = null;
  callState.stream?.getTracks().forEach(track => track.stop()); callState.stream = null;
  callState.peerMedia.clear(); callStage.innerHTML = ''; callStage.classList.remove('active');
  callState.inCall = false;
  sendButton.textContent = '☎'; videoButton.textContent = '▣';
  if (callState.socket?.readyState === WebSocket.OPEN) setStatus('Live chat connected', 'Live chat connected · media call ended');
}

sendButton?.addEventListener('click', () => startCall(false));
videoButton?.addEventListener('click', () => startCall(true));
const imageAttachmentFile=document.getElementById('imageAttachmentFile'),attachImageButton=document.getElementById('attachImageButton'),gifButton=document.getElementById('gifButton'),emojiButton=document.getElementById('emojiButton'),emojiPicker=document.getElementById('emojiPicker'),gifPicker=document.getElementById('gifPicker'),gifSearch=document.getElementById('gifSearch'),gifResults=document.getElementById('gifResults'),gifHelp=document.getElementById('gifHelp'),messageInput=document.getElementById('messageInput');
const standardEmojis='😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😍 🥰 😎 🤔 😭 😡 👍 👎 👋 🙌 👏 🤝 💪 🎉 ❤️ 🧡 💛 💚 💙 💜 ✨ 🔥 ☕ 🌱 🌳 🌻 🌈 🎂 🍕 🍔 🐈 🐕 🦊 🐸 🐼 🚀 ⭐ 💯'.split(' ');
function hideComposerPickers(){emojiPicker.hidden=true;gifPicker.hidden=true;emojiButton?.setAttribute('aria-expanded','false');gifButton?.setAttribute('aria-expanded','false')}
function placeEmoji(value){const start=messageInput.selectionStart??messageInput.value.length,end=messageInput.selectionEnd??start;messageInput.setRangeText(value,start,end,'end');messageInput.focus()}
function buildEmojiPicker(){emojiPicker.replaceChildren();const heading=document.createElement('h3');heading.textContent='Community emoji';emojiPicker.append(heading);const custom=document.createElement('div');custom.className='emoji-grid';for(const [name,imageData] of callState.serverEmojis){const button=document.createElement('button');button.type='button';button.title=`:${name}:`;const image=document.createElement('img');image.src=imageData;image.alt=`:${name}:`;button.append(image);button.onclick=()=>{placeEmoji(`:${name}:`);hideComposerPickers()};custom.append(button)}if(custom.childElementCount)emojiPicker.append(custom);else{const empty=document.createElement('p');empty.textContent='This community has no custom emoji yet.';emojiPicker.append(empty)}const commonTitle=document.createElement('h3');commonTitle.textContent='Emoji';emojiPicker.append(commonTitle);const common=document.createElement('div');common.className='emoji-grid';for(const value of standardEmojis){const button=document.createElement('button');button.type='button';button.textContent=value;button.setAttribute('aria-label',value);button.onclick=()=>{placeEmoji(value);hideComposerPickers()};common.append(button)}emojiPicker.append(common)}
async function sendUploadedMedia(attachment){if(!window.realtimeChat?.isOnline())throw new Error('Connect to the live chat before sending an image.');await window.realtimeChat.sendMessage(`[[media:${attachment.id}]]`)}
attachImageButton?.addEventListener('click',()=>imageAttachmentFile?.click());
imageAttachmentFile?.addEventListener('change',async()=>{const file=imageAttachmentFile.files?.[0];imageAttachmentFile.value='';if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){notify('Choose a PNG, JPEG, WebP, or GIF image.');return}if(file.size>2_500_000){notify('Images must be smaller than 2.5 MB.');return}const server=callState.selectedServer;if(!server){notify('Join a community before sharing an image.');return}try{const imageData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read that image.'));reader.readAsDataURL(file)});const {attachment}=await api(`/api/servers/${server.id}/attachments`,{method:'POST',body:JSON.stringify({imageData})});await sendUploadedMedia(attachment)}catch(error){notify(error.message)}});
emojiButton?.addEventListener('click',()=>{if(!emojiPicker.hidden){hideComposerPickers();return}buildEmojiPicker();hideComposerPickers();emojiPicker.hidden=false;emojiButton.setAttribute('aria-expanded','true')});
let gifSearchTimer;
async function searchTenor(){const query=gifSearch.value.trim();gifResults.replaceChildren();if(!query){gifHelp.textContent='Search Tenor for a GIF to share.';return}gifHelp.textContent='Searching Tenor…';try{const {results}=await api(`/api/tenor/search?q=${encodeURIComponent(query)}`);gifResults.replaceChildren();for(const result of results){const button=document.createElement('button');button.type='button';button.className='gif-result';button.title=result.title;const image=document.createElement('img');image.src=result.previewUrl;image.alt=result.title;image.loading='lazy';button.append(image);button.onclick=async()=>{const server=callState.selectedServer;if(!server){notify('Join a community before sharing a GIF.');return}button.disabled=true;gifHelp.textContent='Sending GIF…';try{const {attachment}=await api(`/api/servers/${server.id}/attachments/tenor`,{method:'POST',body:JSON.stringify({url:result.gifUrl})});await sendUploadedMedia(attachment);hideComposerPickers()}catch(error){gifHelp.textContent=error.message;button.disabled=false}};gifResults.append(button)}gifHelp.textContent=results.length?'Select a GIF to send it to this channel.':'No GIFs found. Try another search.'}catch(error){gifHelp.textContent=error.message}}
gifButton?.addEventListener('click',()=>{if(!gifPicker.hidden){hideComposerPickers();return}hideComposerPickers();gifPicker.hidden=false;gifButton.setAttribute('aria-expanded','true');gifSearch.focus();if(gifSearch.value.trim())searchTenor()});
gifSearch?.addEventListener('input',()=>{clearTimeout(gifSearchTimer);gifSearchTimer=setTimeout(searchTenor,300)});
document.addEventListener('click',event=>{if(!event.target.closest('.composer-wrap'))hideComposerPickers()});
window.realtimeChat = {
  isOnline: () => Boolean(callState.peerId && callState.connected && callState.socket?.readyState === WebSocket.OPEN),
  openCommunity,
  sendMessage: text => request('sendMessage', { text }),
  setRoom,
  startCall: () => startCall(false),
  stopCall
};


// Adapter Telegram (GramJS / MTProto) untuk Engine.
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { CustomFile } from 'telegram/client/uploads';
import { Buffer } from 'buffer';
import { SNAP } from './engine.js';

export async function connectClient({ apiId, apiHash, session, ask, log }) {
  const client = new TelegramClient(new StringSession(session || ''), apiId, apiHash, {
    connectionRetries: 5, floodSleepThreshold: 60, useWSS: true, deviceModel: 'TGPG Web', systemVersion: 'web', appVersion: '0.1.0',
  });
  let errors = 0;
  await client.start({
    phoneNumber: () => ask('Nomor HP (format +62…)'),
    phoneCode: () => ask('Kode login dari Telegram'),
    password: () => ask('Password 2FA Telegram', true),
    onError: e => { log('Login: ' + (e.errorMessage || e.message || e), 'er'); return ++errors >= 3; },
  });
  await client.getDialogs({ limit: 50 }).catch(() => {});   // isi cache entity & mulai terima update
  return { client, session: client.session.save() };
}

const inviteHash = link => link.split('/').pop().replace(/^\+/, '');

/** Buat supergroup privat sebagai log database. */
export async function createChannel(client, name) {
  const r = await client.invoke(new Api.channels.CreateChannel({
    title: 'TGPG · ' + name, about: 'Log database TGPG (terenkripsi). Jangan hapus atau edit pesan.', megagroup: true,
  }));
  const chat = r.chats[0];
  const inv = await client.invoke(new Api.messages.ExportChatInvite({ peer: chat }));
  return { chat, hash: inviteHash(inv.link) };
}

/** Resolve invite hash -> entity (join bila belum anggota). */
export async function resolveInvite(client, hash) {
  const chk = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
  if (chk instanceof Api.ChatInviteAlready) return chk.chat;
  const imp = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
  return imp.chats[0];
}

/** Cari grup yang sudah diikuti (tanpa link undangan; link bisa kedaluwarsa/dicabut): cocokkan id, lalu judul "TGPG · nama".
 *  Mengembalikan { chat, titles } — titles = semua grup TGPG yang terlihat di akun ini (untuk diagnosis). */
export async function findChat(client, id, title = '') {
  const titles = []; let byTitle = null, n = 0;
  for await (const d of client.iterDialogs({})) {
    const e = d.entity; if (!e) continue;
    if (String(e.id) === String(id)) return { chat: e, titles };
    if (/^TGPG · /.test(e.title || '')) { titles.push(e.title); if (title && e.title === 'TGPG · ' + title) byTitle = byTitle ? 'dup' : e; }
    if (++n > 2000) break;
  }
  return { chat: byTitle && byTitle !== 'dup' ? byTitle : null, titles };
}

/** Tambahkan @username ke grup; opsional kirim connection string lewat DM. */
export async function inviteUser(client, chat, username, { connStr = '', sendKey = false } = {}) {
  const name = String(username || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)) throw new Error('Username Telegram tidak valid (5–32 karakter, huruf/angka/_).');
  let user;
  try { user = await client.getInputEntity(name); }
  catch { throw new Error('Username @' + name + ' tidak ditemukan.'); }
  const r = await client.invoke(new Api.channels.InviteToChannel({ channel: chat, users: [user] }));
  if (r && r.missingInvitees && r.missingInvitees.length)
    throw new Error('@' + name + ' tidak bisa ditambahkan (pengaturan privasinya menolak). Kirim link undangan secara manual.');
  let dm = false;
  if (sendKey) {
    await client.sendMessage(user, { message: 'Undangan database TGPG. Buka aplikasi TGPG → Gabung, lalu tempel connection string ini (berisi kunci enkripsi, jangan dibagikan):\n\n' + connStr });
    dm = true;
  }
  return { username: name, dm };
}

export class TelegramTransport {
  constructor(client, entity) { this.client = client; this.entity = entity; }

  async _conn() { if (!this.client.connected) await this.client.connect(); }

  async selfId() { await this._conn(); return String((await this.client.getMe()).id); }

  _wrap(m) {
    return {
      id: m.id,
      text: m.message || '',
      hasFile: !!m.media,
      edited: !!m.editDate,
      sender: m.senderId != null ? String(m.senderId) : '',   // id pengirim dari Telegram (tidak bisa dipalsukan anggota lain)
      download: async () => new Uint8Array(await this.client.downloadMedia(m, {})),
    };
  }

  // reverse + offsetId => pesan dengan id > offsetId, urut naik (GramJS meniru Telethon)
  async listAfter(id, limit) {
    await this._conn();
    const batch = await this.client.getMessages(this.entity, { limit, reverse: true, offsetId: id });
    return [...batch].map(m => this._wrap(m));
  }

  async sendText(text) {
    await this._conn();
    return (await this.client.sendMessage(this.entity, { message: text, parseMode: undefined, linkPreview: false })).id;
  }

  async sendFile(bytes, caption) {
    await this._conn();
    const buf = Buffer.from(bytes);
    const file = new CustomFile('tgpg.bin', buf.length, '', buf);
    return (await this.client.sendFile(this.entity, { file, caption, forceDocument: true, workers: 4 })).id;
  }

  async findSnapshot() {
    await this._conn();
    const found = await this.client.getMessages(this.entity, { limit: 5, search: SNAP });
    const m = [...found].find(x => x.media && (x.message || '').startsWith(SNAP));
    return m ? this._wrap(m) : null;
  }

  subscribe(cb) {
    const handler = () => cb();
    const ev = new NewMessage({ chats: [this.entity] });
    this.client.addEventHandler(handler, ev);
    return () => this.client.removeEventHandler(handler, ev);
  }
}

/** Keluarkan user dari grup (best-effort; pengaman sebenarnya adalah rotasi kunci). */
export async function kickUser(client, chat, userId) {
  const user = await client.getInputEntity(Number(userId));
  await client.invoke(new Api.channels.EditBanned({
    channel: chat, participant: user, bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Uji asumsi yang dipakai TGPG terhadap Telegram sungguhan. Menulis pesan uji (awalan TGDIAG, diabaikan engine) lalu menghapusnya. */
export async function runDiagnostics(client, entity) {
  const out = [], ids = [], tag = 'TGDIAG ' + Date.now();
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail });
  const step = async (name, fn) => { try { await fn(); } catch (e) { add(name, false, e?.errorMessage || e?.message || String(e)); } };
  let me = null, sent = null, got = false;
  const handler = () => { got = true; }, ev = new NewMessage({ chats: [entity] });
  await step('Login (getMe)', async () => { me = await client.getMe(); add('Login (getMe)', me?.id, String(me?.id)); });
  if (!me) return out;
  client.addEventHandler(handler, ev);
  await step('Kirim pesan teks', async () => { sent = await client.sendMessage(entity, { message: tag + ' a', linkPreview: false }); ids.push(sent.id); add('Kirim pesan teks', sent.id, '#' + sent.id); });
  if (sent) {
    await step('Event realtime', async () => {
      for (let i = 0; i < 30 && !got; i++) await sleep(200);
      add('Event realtime (NewMessage)', got, got ? '' : 'tidak ada event dalam 6 dtk; sinkron hanya lewat polling 15 dtk');
    });
    await step('Baca maju', async () => {
      const arr = [...await client.getMessages(entity, { limit: 10, reverse: true, offsetId: sent.id - 1 })];
      const ordered = arr.every((m, i) => i === 0 || m.id > arr[i - 1].id);
      add('Baca maju (reverse + offsetId)', arr.length >= 1 && arr[0].id === sent.id && ordered, arr.length + ' pesan, urut naik: ' + ordered);
      const m0 = arr.find(m => m.id === sent.id);
      add('ID pengirim (senderId) = akun sendiri', m0 && String(m0.senderId) === String(me.id), String(m0?.senderId));
      add('Pesan baru tidak bertanda "diedit"', m0 && !m0.editDate);
    });
  }
  let file = null; const bytes = crypto.getRandomValues(new Uint8Array(2048));
  await step('Kirim/unduh file', async () => {
    const buf = Buffer.from(bytes);
    file = await client.sendFile(entity, { file: new CustomFile('tgpg.bin', buf.length, '', buf), caption: 'TGDIAG-SNAP ' + tag, forceDocument: true, workers: 2 });
    ids.push(file.id);
    const back = new Uint8Array(await client.downloadMedia(file, {}));
    add('Kirim & unduh file (dokumen)', back.length === bytes.length && back.every((b, i) => b === bytes[i]), back.length + ' byte');
  });
  if (file) await step('Pencarian', async () => {
    await sleep(2000);
    const found = [...await client.getMessages(entity, { limit: 5, search: 'TGDIAG-SNAP' })];
    add('Pencarian caption (dipakai mencari snapshot)', found.some(m => m.id === file.id), found.length ? '' : 'indeks pencarian Telegram bisa tertunda; coba lagi beberapa detik');
  });
  client.removeEventHandler(handler, ev);
  await step('Hapus pesan uji', async () => { if (ids.length) await client.deleteMessages(entity, ids, { revoke: true }); add('Bersihkan pesan uji', true); });
  return out;
}

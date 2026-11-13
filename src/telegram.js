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
    password: () => ask('Password 2FA Telegram'),
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

export class TelegramTransport {
  constructor(client, entity) { this.client = client; this.entity = entity; }

  async _conn() { if (!this.client.connected) await this.client.connect(); }

  _wrap(m) {
    return {
      id: m.id,
      text: m.message || '',
      hasFile: !!m.media,
      edited: !!m.editDate,
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

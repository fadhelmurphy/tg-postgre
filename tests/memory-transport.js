// Transport in-memori: meniru channel Telegram (id naik, ada pesan layanan, ada notifikasi realtime).
export class Channel {
  constructor() { this.msgs = []; this.nextId = 1; this.subs = new Set(); }
  push(m) { const msg = { id: this.nextId++, text: '', file: null, ...m }; this.msgs.push(msg); return msg; }
  service() { this.push({ service: true }); }              // mis. "user joined": punya id tapi bukan op
  notify() { for (const s of this.subs) s(); }
  handle() { return new MemoryTransport(this); }
}
class MemoryTransport {
  constructor(ch) { this.ch = ch; }
  _wrap(m) { return { id: m.id, text: m.text, hasFile: !!m.file, download: async () => new Uint8Array(m.file) }; }
  async listAfter(id, limit) { return this.ch.msgs.filter(m => m.id > id).slice(0, limit).map(m => this._wrap(m)); }
  async sendText(text) { const m = this.ch.push({ text }); queueMicrotask(() => this.ch.notify()); return m.id; }
  async sendFile(bytes, caption) { const m = this.ch.push({ text: caption, file: bytes }); queueMicrotask(() => this.ch.notify()); return m.id; }
  async findSnapshot() {
    const s = [...this.ch.msgs].reverse().find(m => m.file && m.text.startsWith('TGPG-SNAP'));
    return s ? this._wrap(s) : null;
  }
  subscribe(cb) { this.ch.subs.add(cb); return () => this.ch.subs.delete(cb); }
}

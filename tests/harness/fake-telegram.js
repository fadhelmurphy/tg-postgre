// Pengganti src/telegram.js untuk uji e2e alur main.js tanpa jaringan: grup Telegram = Channel in-memori.
import { Channel } from '../memory-transport.js';
const chans = new Map(), byHash = new Map(); let n = 1000;
export async function connectClient({ session }) { return { client: { getMe: async () => ({ username: 'tester', id: 1 }) }, session: session || 'S' }; }
export async function createChannel(_c, name) { const id = ++n, chat = { id, title: 'TGPG · ' + name }; chans.set(id, new Channel()); byHash.set('H' + id, chat); return { chat, hash: 'H' + id }; }
export async function resolveInvite(_c, hash) { const c = byHash.get(hash); if (!c) throw new Error('invite tidak dikenal'); return c; }
export async function findChat(_c, id) { return { chat: [...byHash.values()].find(c => String(c.id) === String(id)) || null, titles: [] }; }
export async function exportInvite(_c, chat) { byHash.set('H' + chat.id + 'n', chat); return 'H' + chat.id + 'n'; }
export async function inviteUser() { return { username: 'x', dm: false }; }
export async function kickUser() {}
export async function runDiagnostics() { return []; }
export class TelegramTransport { constructor(_c, chat) { return chans.get(chat.id).handle('1001'); } }
export async function listTgpgChats() { return [...byHash.values()]; }

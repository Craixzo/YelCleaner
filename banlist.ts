// banlist.ts — bans Discord user IDs listed in a Google Sheet.
// Only bans people who are NOT currently in your server and are listed in MIN_SERVERS+ servers.
// Dry run by default. Add --confirm to actually ban.
//
//   npx tsx banlist.ts            -> preview only
//   npx tsx banlist.ts --confirm  -> bans for real

import "dotenv/config";
import { writeFileSync } from "node:fs";

const API = "https://discord.com/api/v10";
const BATCH_SIZE = 200; // Discord bulk-ban max per request

const TOKEN = need("DISCORD_TOKEN");
const GUILD_ID = need("GUILD_ID");
const SHEET_URL = need("SHEET_URL");
const ID_COLUMN = process.env.ID_COLUMN ?? "A"; // column letter OR header name
const SERVERS_COLUMN = process.env.SERVERS_COLUMN ?? "B"; // column letter OR header name
const MIN_SERVERS = Number(process.env.MIN_SERVERS ?? "2");
const REASON = process.env.BAN_REASON ?? "Ban list";
const DELETE_MESSAGE_SECONDS = Number(process.env.DELETE_MESSAGE_SECONDS ?? "0"); // 0..604800
const PROTECTED_IDS = new Set(
  (process.env.PROTECTED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const CONFIRM = process.argv.includes("--confirm");

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

// Turn a normal Sheets link into its CSV export link (keeps the tab's gid).
function toCsvUrl(url: string): string {
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
  if (!id) throw new Error("SHEET_URL doesn't look like a Google Sheets link");
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

// Minimal CSV parser (handles quotes, commas and newlines inside quotes).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Accepts a column letter (A, B, AA) or a header name. Searches every row for the header,
// since this sheet's headers sit below some notes rows.
function columnIndex(spec: string, rows: string[][]): number {
  // Header name first (so "id" isn't mistaken for column letters I+D)
  const want = spec.trim().toLowerCase();
  for (const r of rows.slice(0, 50)) {
    const idx = r.findIndex((h) => h.trim().toLowerCase() === want);
    if (idx !== -1) return idx;
  }
  if (/^[A-Z]{1,2}$/i.test(spec)) {
    return spec.toUpperCase().split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  }
  throw new Error(`No column named "${spec}" in the first 50 rows`);
}

function countServers(cell: string): number {
  return cell.split(",").map((s) => s.trim()).filter(Boolean).length;
}

async function discord(path: string, init: RequestInit = {}): Promise<any> {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": encodeURIComponent(REASON),
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 429) {
      const body: any = await res.json().catch(() => ({}));
      const wait = Math.ceil((body.retry_after ?? 5) * 1000);
      console.log(`Rate limited, waiting ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403 && path.includes("/members")) {
        throw new Error(
          "Can't list server members. Turn on 'Server Members Intent' under Bot in the Discord Developer Portal.",
        );
      }
      throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

// Pages through a Discord list endpoint (members or bans) and returns every entry keyed by user ID.
async function fetchAllByUserId(endpoint: string): Promise<Map<string, any>> {
  const entries = new Map<string, any>();
  let after = "0";
  for (;;) {
    const page: any[] = await discord(`${endpoint}?limit=1000&after=${after}`);
    for (const entry of page) entries.set(entry.user.id, entry);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return entries;
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  // 1. Read the sheet
  const csvRes = await fetch(toCsvUrl(SHEET_URL));
  if (!csvRes.ok) {
    throw new Error(`Couldn't read the sheet (${csvRes.status}). Set sharing to "Anyone with the link: Viewer".`);
  }
  const rows = parseCsv(await csvRes.text());
  if (rows.length === 0) throw new Error("Sheet is empty");
  const idCol = columnIndex(ID_COLUMN, rows);
  const serversCol = columnIndex(SERVERS_COLUMN, rows);

  // 2. Collect valid IDs with how many servers they're listed in (notes/header rows are skipped)
  const serverCount = new Map<string, number>();
  const serverList = new Map<string, string>();
  for (const r of rows) {
    const id = (r[idCol] ?? "").trim();
    if (!/^\d{17,20}$/.test(id)) continue;
    const cell = (r[serversCol] ?? "").trim();
    const n = countServers(cell);
    if (n >= (serverCount.get(id) ?? 0)) {
      serverCount.set(id, n);
      serverList.set(id, cell);
    }
  }
  const totalInSheet = serverCount.size;

  // 3. Keep only people in MIN_SERVERS+ servers
  const ids = new Set([...serverCount].filter(([, n]) => n >= MIN_SERVERS).map(([id]) => id));
  const belowThreshold = totalInSheet - ids.size;

  // 4. Never ban the server owner, the bot, or anyone in PROTECTED_IDS
  const guild = await discord(`/guilds/${GUILD_ID}`);
  const me = await discord(`/users/@me`);
  for (const safe of [guild.owner_id, me.id, ...PROTECTED_IDS]) {
    if (ids.delete(safe)) console.log(`Protected, skipping: ${safe}`);
  }

  // 5. Never ban current members — log every member who appears in the database instead
  //    (all matches, regardless of MIN_SERVERS, most servers first)
  const members = await fetchAllByUserId(`/guilds/${GUILD_ID}/members`);
  const flagged = [...serverCount.keys()]
    .filter((id) => members.has(id))
    .sort((a, b) => (serverCount.get(b) ?? 0) - (serverCount.get(a) ?? 0));
  for (const id of flagged) ids.delete(id);

  const LOG_FILE = "flagged-members.csv";
  const header = "user_id,username,display_name,server_nickname,joined_server,server_count,servers";
  const lines = flagged.map((id) => {
    const m = members.get(id);
    return [
      id,
      m.user.username,
      m.user.global_name ?? "",
      m.nick ?? "",
      (m.joined_at ?? "").slice(0, 10),
      serverCount.get(id),
      serverList.get(id),
    ].map(csvCell).join(",");
  });
  writeFileSync(LOG_FILE, [header, ...lines].join("\n") + "\n");

  // 6. Skip people already banned
  const alreadyBanned = await fetchAllByUserId(`/guilds/${GUILD_ID}/bans`);
  const toBan = [...ids].filter((id) => !alreadyBanned.has(id));

  console.log(`\nServer: ${guild.name}`);
  console.log(`IDs in sheet:                 ${totalInSheet}`);
  console.log(`In fewer than ${MIN_SERVERS} servers (skip): ${belowThreshold}`);
  console.log(`In your server (logged, not banned): ${flagged.length}  -> ${LOG_FILE}`);
  for (const id of flagged.slice(0, 15)) {
    const m = members.get(id);
    console.log(`   ${m.user.username} (${id}) — ${serverCount.get(id)} servers: ${serverList.get(id)}`);
  }
  if (flagged.length > 15) console.log(`   ...and ${flagged.length - 15} more in ${LOG_FILE}`);
  console.log(`Already banned:               ${ids.size - toBan.length}`);
  console.log(`To ban:                       ${toBan.length}`);

  if (!CONFIRM) {
    console.log(`\nDry run — nothing was banned. Re-run with --confirm to ban ${toBan.length} users.`);
    return;
  }

  // 7. Bulk ban in batches of 200
  let banned = 0;
  const failed: string[] = [];
  for (let i = 0; i < toBan.length; i += BATCH_SIZE) {
    const batch = toBan.slice(i, i + BATCH_SIZE);
    const result = await discord(`/guilds/${GUILD_ID}/bulk-ban`, {
      method: "POST",
      body: JSON.stringify({ user_ids: batch, delete_message_seconds: DELETE_MESSAGE_SECONDS }),
    });
    banned += result.banned_users.length;
    failed.push(...result.failed_users);
    console.log(`Batch ${i / BATCH_SIZE + 1}/${Math.ceil(toBan.length / BATCH_SIZE)}: banned ${result.banned_users.length}, failed ${result.failed_users.length}`);
  }

  console.log(`\nDone. Banned ${banned}. Failed ${failed.length}.`);
  if (failed.length) {
    writeFileSync("failed-bans.txt", failed.join("\n") + "\n");
    console.log("Failed IDs written to failed-bans.txt");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/*
 * Dominion AI — SCHEDULED WORK ORDERS (Fred, 2026-07-31).
 *
 * "I want it to organize a file every morning. I place that work order from my phone. It organizes
 * the folder on the desktop and the desktop app shows it in the dashboard."
 *
 * WHY THE ORDER LIVES HERE AND NOT ON A DEVICE. That one decision is what makes "independent of
 * each other, but affects the entire user's app" true for free. The schedule is a row on the
 * server. The phone and the desktop are two windows onto the same row, so placing an order on the
 * phone and cancelling it on the laptop need no device-to-device sync at all, which is the part of
 * this kind of feature that always rots.
 *
 * WHY THERE IS NO MODEL IN THIS FILE. Fred's call, and it is the right one: "instead of trying to
 * trust the interpretation of the different models, why don't we come up with a list of 15 to 20
 * tasks... very straightforward and hard to misinterpret with guardrails built into them." Every
 * task is a fixed entry in TASKS below with a fixed executor. Nothing is interpreted, so nothing
 * can be misinterpreted, a run costs no tokens, and the behaviour is exactly testable. It also
 * buys something an agent could never offer: because each run records precisely what it did, the
 * whole run can be undone.
 *
 * THE TIMEZONE IS NOT DECORATION. "Every morning at 3am" means Fred's 3am. A schedule stored as a
 * UTC hour silently slides by an hour twice a year, and the first anyone notices is when the job
 * runs at 2am in November. Every order carries the IANA zone of the device that placed it, and the
 * next run is computed in that zone every single time rather than by adding 24 hours.
 *
 * WHEN THE TARGET MACHINE IS ASLEEP, which for a 3am job on a laptop is most nights: the order goes
 * to `waiting`, and it does NOT advance its schedule. The hub's onConnect hook fires it the moment
 * that machine reappears. So "every morning" honestly means "at 3am, or the first moment the
 * machine is awake after that", which is what a person means anyway.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const MAX_ORDERS_PER_ACCOUNT = 20;

/*
 * THE TASK LIST. Fred's design: a small set of things nobody can misread. This ships with the one
 * he asked for plus its report-only sibling; the rest of the twenty land behind it, and every one
 * of them is a row here plus an executor, never a prompt.
 *
 * `destructive` is the flag that decides whether a first run is forced to be a dry run.
 */
export const TASKS = {
  sort_by_type: {
    id: "sort_by_type",
    label: "Sort a folder by file type",
    blurb: "Loose files move into Images, Documents, Spreadsheets, Archives, Video, Audio and Other. Never deletes, never overwrites, never touches files already in subfolders.",
    needs: ["folder"],
    movesFiles: true,
    undoable: true,
  },
  folder_report: {
    id: "folder_report",
    label: "Report what is in a folder",
    blurb: "Counts and sizes by file type, the largest files, and what arrived since the last run. Changes nothing at all.",
    needs: ["folder"],
    movesFiles: false,
    undoable: false,
  },
};

export const isTask = (id) => Object.prototype.hasOwnProperty.call(TASKS, id);

/* ---- timezone ------------------------------------------------------------------------------ */

// The wall-clock reading in a given zone for a given instant.
export function zonedParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
  // Intl renders midnight as hour 24 in some engines; normalise it.
  const h = Number(p.hour) === 24 ? 0 : Number(p.hour);
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi: Number(p.minute), s: Number(p.second) };
}

/*
 * The UTC instant at which the clock in `tz` reads the given wall time. Converges by measuring the
 * error and correcting, which handles both fixed offsets and daylight saving without a table.
 * On a spring-forward night the requested wall time may not exist; the loop then lands on the
 * nearest real instant, which is the sane behaviour for "run it at 3".
 */
export function zonedTimeToUtc({ y, mo, d, h, mi = 0 }, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = want;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(guess, tz);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
    const drift = want - got;
    if (drift === 0) break;
    guess += drift;
  }
  return guess;
}

export function isValidZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return true; } catch { return false; }
}

/*
 * The next run at or after `from`. Cadence is deliberately tiny: the point of the feature is that
 * a person picks a time and a rhythm without learning cron.
 *   once   - runs one time, then disables itself
 *   daily  - every day at hh:mm in tz
 *   weekly - every week on `weekday` (0=Sunday) at hh:mm in tz
 */
export function nextRunAt({ cadence = "daily", atHour = 3, atMinute = 0, tz = "America/New_York", weekday = 1 }, from = Date.now()) {
  if (!isValidZone(tz)) tz = "UTC";
  const hh = Math.max(0, Math.min(23, Number(atHour) || 0));
  const mm = Math.max(0, Math.min(59, Number(atMinute) || 0));
  const here = zonedParts(from, tz);
  // Try today, then walk forward. 370 covers a year of weekly steps plus slack.
  for (let add = 0; add < 370; add++) {
    const probe = zonedTimeToUtc({ y: here.y, mo: here.mo, d: here.d + add, h: hh, mi: mm }, tz);
    if (probe <= from) continue;
    if (cadence === "weekly") {
      const wd = new Date(probe).toLocaleString("en-US", { timeZone: tz, weekday: "short" });
      const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      if (map[wd.slice(0, 3)] !== (Number(weekday) % 7)) continue;
    }
    return probe;
  }
  return from + 24 * 3600 * 1000;
}

// Plain words for the dashboard. "Every day at 3:00 AM Eastern" beats a cron string for everyone.
export function describeSchedule({ cadence, atHour, atMinute, tz, weekday }) {
  const h = Number(atHour) || 0, m = Number(atMinute) || 0;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const clock = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  let zone = String(tz || "UTC");
  try {
    const nm = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    if (nm) zone = nm.value;
  } catch {}
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (cadence === "once") return `Once, at ${clock} ${zone}`;
  if (cadence === "weekly") return `Every ${days[Number(weekday) % 7]} at ${clock} ${zone}`;
  return `Every day at ${clock} ${zone}`;
}

/* ---- the store ----------------------------------------------------------------------------- */

export function createWorkOrders({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new Error("createWorkOrders needs a dir");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "workorders.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, uid TEXT NOT NULL, task TEXT NOT NULL, node TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '', cadence TEXT NOT NULL DEFAULT 'daily',
    atHour INTEGER NOT NULL DEFAULT 3, atMinute INTEGER NOT NULL DEFAULT 0,
    weekday INTEGER NOT NULL DEFAULT 1, tz TEXT NOT NULL DEFAULT 'UTC',
    enabled INTEGER NOT NULL DEFAULT 1, dryRunFirst INTEGER NOT NULL DEFAULT 1,
    nextRunAt INTEGER NOT NULL DEFAULT 0, lastRunAt INTEGER NOT NULL DEFAULT 0,
    lastStatus TEXT NOT NULL DEFAULT '', lastSummary TEXT NOT NULL DEFAULT '',
    lastJournal TEXT NOT NULL DEFAULT '', runCount INTEGER NOT NULL DEFAULT 0,
    waitingSince INTEGER NOT NULL DEFAULT 0, seenAt INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL, createdFrom TEXT NOT NULL DEFAULT ''
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS orders_due ON orders (enabled, nextRunAt)");

  const row = (r) => r ? {
    ...r,
    enabled: !!r.enabled, dryRunFirst: !!r.dryRunFirst,
    journal: (() => { try { return JSON.parse(r.lastJournal || "[]"); } catch { return []; } })(),
    schedule: describeSchedule(r),
    taskLabel: (TASKS[r.task] || {}).label || r.task,
  } : null;

  const q = {
    insert: db.prepare(`INSERT INTO orders
      (id,uid,task,node,folder,cadence,atHour,atMinute,weekday,tz,enabled,dryRunFirst,nextRunAt,createdAt,createdFrom)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    byId: db.prepare("SELECT * FROM orders WHERE id = ?"),
    listFor: db.prepare("SELECT * FROM orders WHERE uid = ? ORDER BY createdAt DESC"),
    countFor: db.prepare("SELECT COUNT(*) n FROM orders WHERE uid = ?"),
    due: db.prepare("SELECT * FROM orders WHERE enabled = 1 AND nextRunAt > 0 AND nextRunAt <= ?"),
    waitingOn: db.prepare("SELECT * FROM orders WHERE enabled = 1 AND waitingSince > 0 AND node = ?"),
    del: db.prepare("DELETE FROM orders WHERE id = ? AND uid = ?"),
    setEnabled: db.prepare("UPDATE orders SET enabled = ? WHERE id = ? AND uid = ?"),
    setNext: db.prepare("UPDATE orders SET nextRunAt = ?, waitingSince = 0 WHERE id = ?"),
    setWaiting: db.prepare("UPDATE orders SET waitingSince = ?, lastStatus = ?, lastSummary = ? WHERE id = ?"),
    recordRun: db.prepare(`UPDATE orders SET lastRunAt = ?, lastStatus = ?, lastSummary = ?, lastJournal = ?,
      runCount = runCount + 1, waitingSince = 0, nextRunAt = ?, enabled = ?, dryRunFirst = 0 WHERE id = ?`),
    markSeen: db.prepare("UPDATE orders SET seenAt = ? WHERE uid = ?"),
    unseen: db.prepare("SELECT COUNT(*) n FROM orders WHERE uid = ? AND lastRunAt > seenAt"),
  };

  return {
    db,
    tasks: () => Object.values(TASKS),

    create(uid, o = {}) {
      if (!isTask(o.task)) return { error: "That is not one of the tasks on the list.", code: "unknown_task" };
      const folder = String(o.folder || "").trim();
      if (!folder) return { error: "Which folder? A work order has to name one.", code: "no_folder" };
      // An absolute path only. A relative one has no meaning on a machine nobody is standing at.
      if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(folder)) {
        return { error: "Use the full path to the folder, for example C:\\Users\\You\\Downloads.", code: "not_absolute" };
      }
      if (q.countFor.get(uid).n >= MAX_ORDERS_PER_ACCOUNT) {
        return { error: `That is ${MAX_ORDERS_PER_ACCOUNT} work orders already. Remove one first.`, code: "too_many" };
      }
      const tz = isValidZone(o.tz) ? String(o.tz) : "UTC";
      const cadence = ["once", "daily", "weekly"].includes(o.cadence) ? o.cadence : "daily";
      const rec = {
        id: "wo_" + randomUUID().slice(0, 12), uid, task: o.task, node: String(o.node || "").slice(0, 80),
        folder, cadence,
        atHour: Math.max(0, Math.min(23, Number(o.atHour) || 0)),
        atMinute: Math.max(0, Math.min(59, Number(o.atMinute) || 0)),
        weekday: Math.max(0, Math.min(6, Number(o.weekday) || 0)),
        tz,
        // A task that MOVES files gets a dry run first unless the caller deliberately waives it.
        // Nothing that rearranges somebody's documents should do it unattended on its first outing.
        dryRunFirst: TASKS[o.task].movesFiles ? (o.dryRunFirst === false ? 0 : 1) : 0,
      };
      const next = nextRunAt(rec, now());
      q.insert.run(rec.id, rec.uid, rec.task, rec.node, rec.folder, rec.cadence, rec.atHour, rec.atMinute,
        rec.weekday, rec.tz, 1, rec.dryRunFirst, next, now(), String(o.createdFrom || "").slice(0, 40));
      return { ok: true, order: row(q.byId.get(rec.id)) };
    },

    get: (id) => row(q.byId.get(String(id || ""))),
    list: (uid) => q.listFor.all(uid).map(row),
    due: (t = now()) => q.due.all(t).map(row),
    waitingOn: (node) => q.waitingOn.all(String(node || "")).map(row),
    remove: (uid, id) => ({ ok: q.del.run(id, uid).changes > 0 }),
    setEnabled: (uid, id, on) => ({ ok: q.setEnabled.run(on ? 1 : 0, id, uid).changes > 0 }),
    unseenCount: (uid) => q.unseen.get(uid).n,
    markSeen: (uid) => { q.markSeen.run(now(), uid); return { ok: true }; },

    /*
     * The machine was not there. The schedule is deliberately NOT advanced, so the order stays due
     * and fires the moment that machine reconnects. Advancing it here would mean a laptop that
     * sleeps through 3am every night never runs the job at all, while the dashboard cheerfully
     * showed a future run time.
     */
    markWaiting(id, whyNode) {
      q.setWaiting.run(now(), "waiting", `Waiting for ${whyNode || "the machine"} to come online.`, id);
      return row(q.byId.get(id));
    },

    recordRun(id, { ok, summary, journal = [], dryRun = false }) {
      const cur = q.byId.get(id);
      if (!cur) return null;
      // A one-shot order disables itself after a real run. A dry run never counts as the one shot,
      // because the point of the dry run is that the real work still has to happen.
      const finished = cur.cadence === "once" && !dryRun;
      const next = finished ? 0 : nextRunAt(cur, now());
      q.recordRun.run(now(), ok ? (dryRun ? "dry-run" : "ok") : "failed", String(summary || "").slice(0, 500),
        JSON.stringify(journal).slice(0, 400000), next, finished ? 0 : 1, id);
      return row(q.byId.get(id));
    },
  };
}

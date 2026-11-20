/**
 * Sticker catalog + alias store (runtime data, NOT config).
 *
 * Persisted to `$DSH_HOME/telegram-stickers.json` (or `stickerStorePath`).
 * Shape:
 *   {
 *     aliases:  { [name]: fileUniqueId },
 *     stickers: { [fileUniqueId]: { ...full Sticker structure } },
 *     sets:     { [setName]: { title, stickerType, stickerUniqueIds: [] } }
 *   }
 *
 * Key facts driving the design:
 * - Stickers are keyed by Telegram's `file_unique_id` (stable across bots and
 *   time, collision-free), NOT by emoji (a pack commonly reuses one emoji for
 *   several stickers) and NOT by `file_id` (bot-scoped and can go stale).
 * - The full sticker structure is kept (emoji, dimensions, is_animated/
 *   is_video, thumbnail file_id, ...) so the agent can *choose* stickers by
 *   content and so a stale `file_id` can be re-resolved after a set refresh.
 * - Sets are collected automatically: when the user sends any sticker from a
 *   pack, the whole pack is fetched (getStickerSet) and merged here.
 *
 * Concurrency: writes are atomic (tmp + rename) and serialized through a
 * per-instance promise chain. Reads re-load from disk when the file changed
 * under us (other bot process / manual edit), guarded by mtime+size.
 *
 * @module dsh-plugin-telegram/sticker-store
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const EMPTY = () => ({ aliases: {}, stickers: {}, sets: {} });

/** Normalize a raw Bot API Sticker object to our stored (camelCase) shape. */
export function normalizeSticker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const uniqueId = String(raw.file_unique_id || '');
  if (!uniqueId) return null;
  return {
    fileUniqueId: uniqueId,
    fileId: String(raw.file_id || ''),
    type: String(raw.type || 'regular'),            // regular | mask | custom_emoji
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    isAnimated: raw.is_animated === true,
    isVideo: raw.is_video === true,
    emoji: raw.emoji || undefined,
    setName: raw.set_name || undefined,
    customEmojiId: raw.custom_emoji_id || undefined,
    isPremium: raw.is_premium === true || undefined,
    fileSize: typeof raw.file_size === 'number' ? raw.file_size : undefined,
    thumbnail: raw.thumbnail && raw.thumbnail.file_id
      ? {
          fileId: String(raw.thumbnail.file_id),
          fileUniqueId: raw.thumbnail.file_unique_id ? String(raw.thumbnail.file_unique_id) : undefined,
          width: Number(raw.thumbnail.width) || 0,
          height: Number(raw.thumbnail.height) || 0,
        }
      : undefined,
  };
}

/** Describe a stored sticker in one compact human/agent-readable line. */
export function describeSticker(s) {
  if (!s) return '(unknown sticker)';
  const fmt = s.isAnimated ? 'animated' : (s.isVideo ? 'video' : 'static');
  const dims = (s.width && s.height) ? `, ${s.width}×${s.height}` : '';
  const set = s.setName ? ` from set “${s.setName}”` : ' (no set)';
  return `${s.emoji || '•'} (${fmt}${dims})${set} — id: ${s.fileUniqueId}`;
}

export function createStickerStore({ storePath, log = () => {} }) {
  if (!storePath) throw new Error('createStickerStore: storePath is required');

  let cache = null;
  let cacheSig = ''; // mtime+size guard for external edits

  function load() {
    let st = null;
    try { st = statSync(storePath, { throwIfNoEntry: false }); } catch { /* gone */ }
    const sig = st ? `${st.mtimeMs}:${st.size}` : '';
    if (cache && sig === cacheSig) return cache;
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      cache = {
        aliases: (raw.aliases && typeof raw.aliases === 'object') ? raw.aliases : {},
        stickers: (raw.stickers && typeof raw.stickers === 'object') ? raw.stickers : {},
        sets: (raw.sets && typeof raw.sets === 'object') ? raw.sets : {},
      };
    } catch {
      cache = EMPTY();
    }
    cacheSig = sig;
    return cache;
  }

  let writeChain = Promise.resolve();
  function save() {
    // Serialize writes; each write snapshots the CURRENT in-memory state, so a
    // queued save never clobbers newer data with an older snapshot. The chain
    // variable is REASSIGNED so every new save queues behind the previous one
    // (a shared resolved promise would let concurrent saves race on the .tmp
    // path).
    const snapshot = JSON.stringify(cache, null, 2);
    const run = writeChain.then(() => {
      try {
        mkdirSync(dirname(storePath), { recursive: true });
        const tmp = `${storePath}.tmp`;
        writeFileSync(tmp, snapshot);
        renameSync(tmp, storePath);
        const st = statSync(storePath, { throwIfNoEntry: false });
        cacheSig = st ? `${st.mtimeMs}:${st.size}` : '';
      } catch (err) {
        log('warn', `sticker-store: save failed: ${err.message}`);
      }
    });
    writeChain = run;
    return run;
  }

  return {
    /** Raw catalog (read-only view; callers must not mutate). */
    data() {
      return load();
    },

    /** All aliases: { name: fileUniqueId }. */
    listAliases() {
      return { ...load().aliases };
    },

    /** Resolve an alias name to a stored full sticker (or null). */
    resolveAlias(name) {
      const d = load();
      const uid = d.aliases[String(name || '').trim().toLowerCase()];
      return uid ? (d.stickers[uid] || null) : null;
    },

    /**
     * Find a stored sticker by id — accepts a file_unique_id (preferred) or a
     * file_id. Returns the stored full sticker, or null.
     */
    findByAnyId(id) {
      const d = load();
      const key = String(id || '');
      if (d.stickers[key]) return d.stickers[key];
      for (const s of Object.values(d.stickers)) {
        if (s.fileId === key) return s;
      }
      return null;
    },

    /**
     * Merge one sticker (already normalized) into the catalog. Returns true
     * when anything changed.
     */
    recordSticker(sticker) {
      if (!sticker) return false;
      const d = load();
      const prev = d.stickers[sticker.fileUniqueId];
      if (prev && JSON.stringify(prev) === JSON.stringify(sticker)) return false;
      d.stickers[sticker.fileUniqueId] = sticker;
      return true;
    },

    /**
     * Merge a whole sticker set (getStickerSet result, raw Bot API shape) into
     * the catalog: every sticker by unique id + set metadata. Returns
     * { added, total } counts.
     */
    recordSet(rawSet) {
      const d = load();
      const name = String(rawSet?.name || '');
      if (!name) return { added: 0, total: 0 };
      const stickers = Array.isArray(rawSet.stickers) ? rawSet.stickers : [];
      const entry = d.sets[name] || { title: undefined, stickerType: undefined, stickerUniqueIds: [] };
      entry.title = rawSet.title || entry.title;
      entry.stickerType = rawSet.sticker_type || entry.stickerType;
      entry.thumbnail = rawSet.thumbnail && rawSet.thumbnail.file_id
        ? { fileId: String(rawSet.thumbnail.file_id), width: Number(rawSet.thumbnail.width) || 0, height: Number(rawSet.thumbnail.height) || 0 }
        : entry.thumbnail;
      let added = 0;
      const ids = new Set(entry.stickerUniqueIds);
      for (const raw of stickers) {
        const s = normalizeSticker(raw);
        if (!s) continue;
        if (recordStickerIn(d, s)) added++;
        ids.add(s.fileUniqueId);
      }
      entry.stickerUniqueIds = [...ids];
      d.sets[name] = entry;
      return { added, total: entry.stickerUniqueIds.length };
    },

    /** Define/replace an alias. `target` = fileUniqueId, file_id, or sticker object. */
    setAlias(name, target) {
      const d = load();
      const key = String(name || '').trim().toLowerCase();
      if (!key) throw new Error('alias name is required');
      let sticker = null;
      if (target && typeof target === 'object') {
        sticker = normalizeSticker(target);
      } else {
        sticker = this.findByAnyId(target);
      }
      if (!sticker) throw new Error(`sticker not found in catalog for: ${target}`);
      if (sticker.type === 'custom_emoji') {
        // Custom-emoji stickers render as inline emoji entities for the USER,
        // but a bot CAN resend them by file_id — allowed, just note it.
        log('info', `sticker-store: alias “${key}” is a custom_emoji sticker`);
      }
      d.aliases[key] = sticker.fileUniqueId;
      this.recordSticker(sticker);
      return { alias: key, sticker };
    },

    /** Remove an alias. Returns true when it existed. */
    removeAlias(name) {
      const d = load();
      const key = String(name || '').trim().toLowerCase();
      if (!(key in d.aliases)) return false;
      delete d.aliases[key];
      return true;
    },

    /** List stickers of one set (stored copies), normalized. */
    listSet(name) {
      const d = load();
      const entry = d.sets[String(name || '')];
      if (!entry) return null;
      return {
        name: String(name),
        title: entry.title,
        stickerType: entry.stickerType,
        stickers: (entry.stickerUniqueIds || []).map((uid) => d.stickers[uid]).filter(Boolean),
      };
    },

    /** Persist the current state (call after mutating operations). */
    flush() {
      return save();
    },
  };
}

// Same as store.recordSticker but operating on a raw catalog object (used
// inside recordSet before save). Kept module-private.
function recordStickerIn(d, sticker) {
  const prev = d.stickers[sticker.fileUniqueId];
  if (prev && JSON.stringify(prev) === JSON.stringify(sticker)) return false;
  d.stickers[sticker.fileUniqueId] = sticker;
  return true;
}

/** Default catalog location: `$DSH_HOME/telegram-stickers.json`. */
export function defaultStickerStorePath() {
  const home = process.env.DSH_HOME
    || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');
  return join(home, 'telegram-stickers.json');
}

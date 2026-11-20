// sticker-store: catalog + alias store unit tests (pure module, tmp files).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStickerStore,
  defaultStickerStorePath,
  normalizeSticker,
  describeSticker,
} from '../lib/sticker-store.js';

const results = [];
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const RAW = {
  file_id: 'agg-file-id-1',
  file_unique_id: 'uid-1',
  type: 'regular',
  width: 512,
  height: 512,
  is_animated: false,
  is_video: true,
  emoji: '🩹',
  set_name: 'by_cats',
  file_size: 12345,
  thumbnail: { file_id: 'thumb-1', file_unique_id: 'thumb-uid-1', width: 128, height: 128 },
};

test('normalizeSticker maps the raw Bot API shape (camelCase, thumbnail)', () => {
  const s = normalizeSticker(RAW);
  assert(s.fileUniqueId === 'uid-1');
  assert(s.fileId === 'agg-file-id-1');
  assert(s.isVideo === true && s.isAnimated === false);
  assert(s.emoji === '🩹' && s.setName === 'by_cats');
  assert(s.thumbnail.fileId === 'thumb-1');
  assert(normalizeSticker(null) === null);
  assert(normalizeSticker({ file_id: 'x' }) === null); // no file_unique_id
});

test('describeSticker renders emoji/format/dims/set/id', () => {
  const line = describeSticker(normalizeSticker(RAW));
  assert(line.includes('🩹') && line.includes('video') && line.includes('512×512'), line);
  assert(line.includes('by_cats') && line.includes('uid-1'), line);
  assert(describeSticker(null) === '(unknown sticker)');
});

const dir = mkdtempSync(join(tmpdir(), 'dsh-sticker-test-'));
const storePath = join(dir, 'stickers.json');

test('recordSet caches every sticker + set metadata; listSet reads it back', async () => {
  const store = createStickerStore({ storePath, log: () => {} });
  const rawSet = {
    name: 'by_cats', title: 'By Cats', sticker_type: 'regular',
    stickers: [RAW, { ...RAW, file_id: 'f2', file_unique_id: 'uid-2', emoji: '🐈' }],
  };
  const { added, total } = store.recordSet(rawSet);
  assert(added === 2 && total === 2);
  const listed = store.listSet('by_cats');
  assert(listed.title === 'By Cats' && listed.stickers.length === 2);
  assert(store.listSet('nope') === null);
  await store.flush(); // subsequent tests open fresh stores from disk
});

test('aliases: set / resolve / list / remove (case-insensitive)', () => {
  const store = createStickerStore({ storePath, log: () => {} });
  const { alias } = store.setAlias('Med-Time', 'uid-1');
  assert(alias === 'med-time');
  assert(store.resolveAlias('MED-time').fileUniqueId === 'uid-1');
  assert(store.listAliases()['med-time'] === 'uid-1');
  assert(store.removeAlias('no-such') === false);
  assert(store.removeAlias('med-time') === true);
  store.setAlias('again', 'uid-2');
  assert(store.removeAlias('again') === true);
});

test('findByAnyId accepts file_unique_id and file_id; unknown -> null', () => {
  const store = createStickerStore({ storePath, log: () => {} });
  assert(store.findByAnyId('uid-1').fileId === 'agg-file-id-1');
  assert(store.findByAnyId('agg-file-id-1').fileUniqueId === 'uid-1');
  assert(store.findByAnyId('unknown') === null);
});

test('flush persists atomically and reload sees external edits', async () => {
  const store = createStickerStore({ storePath, log: () => {} });
  store.setAlias('persist', 'uid-1');
  await store.flush();
  const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
  assert(onDisk.aliases.persist === 'uid-1');
  assert(onDisk.stickers['uid-1'].emoji === '🩹');
  // external edit visible after the file changed on disk (mtime+size guard)
  writeFileSync(storePath, JSON.stringify({ aliases: { ext: 'uid-2' }, stickers: {}, sets: {} }));
  const store2 = createStickerStore({ storePath, log: () => {} });
  assert(store2.listAliases().ext === 'uid-2');
});

test('defaultStickerStorePath honours DSH_HOME', () => {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-test-home';
  assert(defaultStickerStorePath() === join('/tmp/dsh-test-home', 'telegram-stickers.json'));
  if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
});

// Run sequentially (some tests depend on the previous one's flushed state).
for (const { name, fn } of queue) {
  try { await fn(); results.push(['ok', name]); }
  catch (err) { results.push(['FAIL', `${name}: ${err.message}`]); }
}

let failed = 0;
for (const [status, name] of results) {
  console.log(`  ${status}  ${name}`);
  if (status === 'FAIL') failed++;
}
console.log(`sticker-store: ${results.length - failed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

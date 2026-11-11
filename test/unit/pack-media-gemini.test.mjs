import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { resolveSettings, transcribeTool, understandTool } from '../../packages/dsh-tool-ultra-pack-media/lib/index.js'
import { analyseGemini } from '../../packages/dsh-tool-ultra-pack-media/lib/gemini/client.js'
import { DEFAULT_GEMINI_KEY_FILE, DEFAULT_GEMINI_MODEL, resolveGeminiKey } from '../../packages/dsh-tool-ultra-pack-media/lib/gemini/settings.js'

const ORIGIN = 'https://generativelanguage.googleapis.com'
const API = `${ORIGIN}/v1beta`
const UPLOAD = `${ORIGIN}/upload/v1beta/files?upload_id=test`
const KEY = 'test-secret+/do-not-echo'
const PROSE = '[00:00] A person waves beside a sign.'
const SEGMENTS = [{ start: 0, end: 2, speaker: 1, text: '你好', tone: 'happy' }]
const TRANSCRIPT = JSON.stringify({ segments: SEGMENTS })
const json = (value, status = 200) => Response.json(value, { status })
const candidate = (text) => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'media-gemini-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const oldKey = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  t.after(() => {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = oldKey
  })
  const path = join(dir, 'clip.mp4')
  await writeFile(path, 'media bytes')
  const settings = resolveSettings({
    outputDir: dir,
    geminiKeyFile: join(dir, 'missing.key'),
    geminiUploads: true,
    lang: 'en',
    ...config,
  })
  return { dir, path, settings }
}

function mockApi(t, options = {}) {
  const calls = []
  let polls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init })
    options.beforeRequest?.(url, init)
    if (init.method === 'DELETE') {
      if (options.deleteError) throw new Error(KEY)
      return new Response(null, { status: 204 })
    }
    if (url === `${ORIGIN}/upload/v1beta/files`) {
      if (options.startError) throw new Error(`fetch ${url}?key=${KEY}\n${encodeURIComponent(KEY)}`)
      return new Response(null, { headers: { 'x-goog-upload-url': options.uploadUrl ?? UPLOAD } })
    }
    if (url === UPLOAD) return json({ file: { name: 'files/test', uri: `${API}/files/test`, state: 'PROCESSING' } })
    if (url === `${API}/files/test`) {
      polls++
      return json({ name: 'files/test', uri: `${API}/files/test`, state: options.state ?? (polls === 1 ? 'PROCESSING' : 'ACTIVE') })
    }
    if (url.endsWith(':generateContent')) {
      if (options.generateError) return json({ error: { message: `${KEY}\n${encodeURIComponent(KEY)}` } }, 429)
      const structured = JSON.parse(init.body).generationConfig?.responseMimeType === 'application/json'
      return options.response?.() ?? candidate(options.text ?? (structured ? TRANSCRIPT : PROSE))
    }
    assert.fail(`Unexpected URL: ${url}`)
  })
  return calls
}

test('Gemini: key precedence, whitespace, missing/empty files, tilde default and environment', async (t) => {
  const { dir, settings } = await fixture(t)
  assert.equal(settings.gemini.model, DEFAULT_GEMINI_MODEL)
  assert.equal(settings.gemini.uploads, true)
  assert.equal(resolveSettings({}).gemini.uploads, false)
  assert.equal(resolveSettings({ geminiUploads: false }).gemini.uploads, false)
  assert.equal(resolveSettings({}).gemini.keyFile, DEFAULT_GEMINI_KEY_FILE)
  const keyFile = join(dir, 'gemini.key')
  await writeFile(keyFile, '  file-key\n')
  process.env.GEMINI_API_KEY = ' env-key\n'
  assert.equal(await resolveGeminiKey({ ...settings.gemini, apiKey: ' config-key\n', keyFile }), 'config-key')
  assert.equal(await resolveGeminiKey({ ...settings.gemini, apiKey: ' ', keyFile }), 'file-key')
  await writeFile(keyFile, ' \n')
  assert.equal(await resolveGeminiKey({ ...settings.gemini, keyFile }), 'env-key')
  assert.equal(await resolveGeminiKey(settings.gemini), 'env-key')
  delete process.env.GEMINI_API_KEY
  assert.equal(await resolveGeminiKey(settings.gemini), undefined)
  await assert.rejects(resolveGeminiKey({ ...settings.gemini, keyFile: dir }), /keyFile/)
})

test('Gemini: REST upload → processing → active → generate → delete uses only header credentials', async (t) => {
  const { path } = await fixture(t)
  const calls = mockApi(t)
  assert.equal(await analyseGemini(path, 'Describe motion and OCR.', DEFAULT_GEMINI_MODEL, KEY, { pollMs: 0 }), PROSE)
  assert.deepEqual(calls.map((c) => [c.url, c.method]), [
    [`${ORIGIN}/upload/v1beta/files`, 'POST'], [UPLOAD, 'POST'],
    [`${API}/files/test`, 'GET'], [`${API}/files/test`, 'GET'],
    [`${API}/models/${DEFAULT_GEMINI_MODEL}:generateContent`, 'POST'], [`${API}/files/test`, 'DELETE'],
  ])
  for (const call of calls) {
    assert.equal(call.headers.get('x-goog-api-key'), KEY)
    assert.equal(new URL(call.url).searchParams.has('key'), false)
    assert.ok(call.signal instanceof AbortSignal)
    assert.equal(call.redirect, 'error')
  }
  assert.equal(calls[0].headers.get('x-goog-upload-protocol'), 'resumable')
  assert.equal(calls[0].headers.get('x-goog-upload-command'), 'start')
  assert.equal(calls[0].headers.get('x-goog-upload-header-content-length'), '11')
  assert.equal(calls[0].headers.get('x-goog-upload-header-content-type'), 'video/mp4')
  assert.deepEqual(JSON.parse(calls[0].body), { file: { display_name: 'media' } })
  assert.equal(calls[1].headers.get('x-goog-upload-command'), 'upload, finalize')
  assert.equal(calls[1].headers.get('x-goog-upload-offset'), '0')
  assert.equal(calls[1].headers.get('content-length'), '11')
  assert.equal(await calls[1].body.text(), 'media bytes')
  assert.deepEqual(JSON.parse(calls[4].body).contents[0].parts, [
    { file_data: { mime_type: 'video/mp4', file_uri: `${API}/files/test` } }, { text: 'Describe motion and OCR.' },
  ])
})

test('Gemini: errors are key-free and generation failures still delete the file', async (t) => {
  const { path } = await fixture(t)
  const calls = mockApi(t, { generateError: true })
  await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY, { pollMs: 0 }), (error) => {
    assert.equal(error.message, 'HTTP 429')
    assert.doesNotMatch(String(error), /test-secret|do-not-echo/)
    return true
  })
  assert.equal(calls.at(-1).method, 'DELETE')
})

test('Gemini: FAILED, processing timeout, malformed and blocked responses delete the file', async (t) => {
  for (const options of [
    { state: 'FAILED' }, { state: 'PROCESSING' }, { response: () => json({}) },
    { response: () => json({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'blocked' }] } }] }) },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { path } = await fixture(t)
      const calls = mockApi(t, options)
      await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY, { pollMs: 0, processingTimeoutMs: 100 }))
      assert.equal(calls.at(-1).method, 'DELETE')
    })
  }
})

test('Gemini: requests and body reads time out even if fetch ignores abort', async (t) => {
  const { path } = await fixture(t)
  for (const response of [() => new Promise(() => {}), () => ({ ok: true, headers: { get: () => UPLOAD }, json: () => new Promise(() => {}) })]) {
    t.mock.method(globalThis, 'fetch', response)
    await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY, { uploadTimeoutMs: 15 }), /timeout/)
    t.mock.restoreAll()
  }
})

test('Gemini: upload budget scales to 2 GB, and later phases get independent budgets', async (t) => {
  for (const size of [11, 500 * 1024 ** 2, 2 * 1024 ** 3]) {
    await t.test(`${size} bytes`, async (t) => {
      const { path } = await fixture(t)
      await truncate(path, size)
      const uploadBudget = 120_000 + Math.ceil(size / 125_000 * 1000)
      const scheduled = []
      const schedule = globalThis.setTimeout
      t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
        scheduled.push(ms)
        return schedule(fn, ms, ...args)
      })
      let now = 1000
      let polls = 0
      t.mock.method(Date, 'now', () => now)
      mockApi(t, { beforeRequest: (url, init) => {
        if (url === `${ORIGIN}/upload/v1beta/files`) now += 1000
        else if (url === UPLOAD) now += uploadBudget - 2000
        else if (init.method === 'GET') now += ++polls === 1 ? 500_000 : 90_000
        else if (url.endsWith(':generateContent')) now += 250_000
      } })
      const result = await analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY, { pollMs: 0 })
      assert.equal(result, PROSE)
      assert.deepEqual(scheduled, [uploadBudget, uploadBudget - 1000, 600_000, 100_000, 300_000, 5000])
    })
  }
})

test('Gemini: processing and generation timeouts still delete the uploaded file', async (t) => {
  for (const phase of ['processing', 'generation']) {
    await t.test(phase, async (t) => {
      const { path } = await fixture(t)
      const calls = mockApi(t, { state: 'ACTIVE' })
      const respond = globalThis.fetch
      t.mock.method(globalThis, 'fetch', (url, init) => {
        const stalled = phase === 'processing' ? init.method === 'GET' : url.endsWith(':generateContent')
        if (stalled) return new Promise(() => {})
        return respond(url, init)
      })
      const options = { processingTimeoutMs: 30, generationTimeoutMs: 30 }
      await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY, options), /timeout/)
      assert.equal(calls.at(-1).method, 'DELETE')
      assert.equal(calls.at(-1).signal.aborted, false, 'cleanup has its own budget and signal')
    })
  }
})

test('Gemini: unsafe upload URLs, oversized files and invalid models fail before sending media', async (t) => {
  const { path } = await fixture(t)
  for (const uploadUrl of ['https://example.org/upload', `${UPLOAD}&key=${encodeURIComponent(KEY)}`, 'http://generativelanguage.googleapis.com/upload/v1beta/files']) {
    const calls = mockApi(t, { uploadUrl })
    await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY), /uploadUrl/)
    assert.equal(calls.length, 1)
    t.mock.restoreAll()
  }
  const calls = mockApi(t)
  await assert.rejects(analyseGemini(path, 'test', `bad/model?key=${KEY}`, KEY), /model/)
  await truncate(path, 2 * 1024 ** 3 + 1)
  await assert.rejects(analyseGemini(path, 'test', DEFAULT_GEMINI_MODEL, KEY), /tooLarge/)
  assert.equal(calls.length, 0)
})

/** Stub both media programs, while still making real storyboards and subtitle files. */
function mediaDeps(video = false) {
  const calls = []
  let localCalls = 0
  const run = async (program, args) => {
    calls.push(program)
    if (program === 'ffprobe') return JSON.stringify({
      format: { duration: '3' },
      streams: [{ codec_type: 'audio' }, ...(video ? [{ codec_type: 'video', width: 320, height: 180, avg_frame_rate: '24/1' }] : [])],
    })
    const output = args.at(-1)
    if (output === '-') return ''
    if (output.endsWith('.jpg')) {
      await writeFile(output.replace('%02d', '01'), await sharp({ create: { width: 320, height: 180, channels: 3, background: '#345' } }).jpeg().toBuffer())
    } else await writeFile(output, Buffer.from(new Float32Array(16000).buffer))
    return ''
  }
  const transcriber = async () => {
    localCalls++
    return [{ start: 0, end: 1, text: 'local words' }]
  }
  return { run, transcriber, calls, localCalls: () => localCalls }
}

test('media engines: uploads off keeps auto quiet and local even with keys present', async (t) => {
  for (const factory of [transcribeTool, understandTool]) {
    for (const engine of [undefined, 'auto', 'local']) {
      await t.test(`${factory.name}/${engine}`, async (t) => {
        const { settings, dir } = await fixture(t, { geminiUploads: false })
        settings.gemini.apiKey = KEY
        settings.gemini.keyFile = join(dir, 'gemini.key')
        await writeFile(settings.gemini.keyFile, KEY)
        process.env.GEMINI_API_KEY = KEY
        const calls = mockApi(t)
        const deps = mediaDeps()
        const result = await factory(settings, deps).execute({ file: 'clip.mp4', engine })
        assert.match(result, /^File .*clip.mp4/)
        assert.match(result, /local words/)
        assert.doesNotMatch(result, /Gemini|test-secret|do-not-echo/)
        assert.equal(deps.localCalls(), 1)
        assert.equal(calls.length, 0)
      })
    }
  }
})

test('media engines: uploads off gives explicit gemini one localized reason without reading keys', async (t) => {
  const reasons = {
    en: 'Gemini uploads are off (set geminiUploads: true)',
    'zh-CN': 'Gemini 上传已关闭（设置 geminiUploads: true 可开启）',
  }
  for (const factory of [transcribeTool, understandTool]) {
    for (const [lang, reason] of Object.entries(reasons)) {
      await t.test(`${factory.name}/${lang}`, async (t) => {
        const { settings } = await fixture(t, { geminiUploads: false, lang })
        let keyReads = 0
        for (const property of ['apiKey', 'keyFile']) {
          Object.defineProperty(settings.gemini, property, {
            get() {
              keyReads++
              throw new Error('Key access forbidden while uploads are off')
            },
          })
        }
        const calls = mockApi(t)
        const deps = mediaDeps()
        const tool = factory(settings, deps)
        assert.match(tool.parameters.engine.description, /geminiUploads: true/)
        const result = await tool.execute({ file: 'clip.mp4', engine: 'gemini' })
        const lines = result.split('\n')
        assert.equal(lines[0], reason)
        assert.match(lines[1], /^File .*clip.mp4/)
        assert.equal(lines.filter((line) => line.includes('Gemini')).length, 1)
        assert.match(result, /local words/)
        assert.equal(deps.localCalls(), 1)
        assert.equal(calls.length, 0)
        assert.equal(keyReads, 0)
      })
    }
  }
})

test('media engines: auto with and without a key, local with a key, and gemini with and without a key', async (t) => {
  for (const factory of [transcribeTool, understandTool]) {
    for (const [engine, key, expectedRemote] of [[undefined, true, true], [undefined, false, false], ['auto', true, true], ['auto', false, false], ['local', true, false], ['gemini', true, true], ['gemini', false, false]]) {
      await t.test(`${factory.name}/${engine}/${key}`, async (t) => {
        const { settings } = await fixture(t)
        if (key) settings.gemini.apiKey = KEY
        const calls = mockApi(t, { state: 'ACTIVE' })
        const deps = mediaDeps()
        const tool = factory(settings, deps)
        assert.deepEqual(tool.parameters.engine.enum, ['auto', 'local', 'gemini'])
        assert.equal(tool.parameters.engine.default, 'auto')
        const result = await tool.execute({ file: 'clip.mp4', engine })
        assert.match(result, /File .*clip.mp4: 00:03 long, no picture, with sound/)
        assert.equal(calls.length > 0, expectedRemote)
        assert.equal(deps.localCalls(), expectedRemote ? 0 : 1)
        if (expectedRemote) assert.match(result, new RegExp(`analysed by Gemini ${DEFAULT_GEMINI_MODEL} \\(file uploaded to Google\\)`))
        else assert.doesNotMatch(result, /analysed by Gemini/)
        if (engine === 'gemini' && !key) assert.equal(result.split('\n')[0], 'no Gemini key configured (set geminiApiKey or ~/.config/swiftnest/gemini.key)')
        await assert.rejects(tool.execute({ file: 'clip.mp4', engine: 'unknown' }), /engine must/)
      })
    }
  }
})

test('media engines: HTTP and fetch failures return one safe reason line then the local pipeline', async (t) => {
  for (const factory of [transcribeTool, understandTool]) {
    for (const options of [{ generateError: true }, { startError: true }]) {
      await t.test(`${factory.name}/${JSON.stringify(options)}`, async (t) => {
        const { settings } = await fixture(t)
        settings.gemini.apiKey = KEY
        const calls = mockApi(t, { ...options, state: 'ACTIVE' })
        const deps = mediaDeps()
        const result = await factory(settings, deps).execute({ file: 'clip.mp4' })
        const reason = options.generateError ? 'HTTP 429' : 'network request failed'
        assert.equal(result.split('\n')[0], `Gemini unavailable; using local: ${reason}`)
        assert.match(result, /\nFile .*clip.mp4/)
        assert.match(result, /local words/)
        assert.doesNotMatch(result, /test-secret|do-not-echo|test-secret%2B/)
        assert.equal(deps.localCalls(), 1)
        if (options.generateError) assert.equal(calls.at(-1).method, 'DELETE')
      })
    }
  }
})

test('media engines: Gemini saves storyboard and SRT, honours options, and redacts echoed keys', async (t) => {
  const { settings } = await fixture(t)
  settings.gemini.apiKey = KEY
  settings.gemini.model = 'custom-flash'
  const calls = mockApi(t, { text: `[00:00] action, OCR ${KEY} ${encodeURIComponent(KEY)}`, state: 'ACTIVE', deleteError: true })
  const deps = mediaDeps(true)
  const video = await understandTool(settings, deps).execute({ file: 'clip.mp4', frames: 4, transcript: false })
  assert.match(video, /analysed by Gemini custom-flash \(file uploaded to Google\)/)
  assert.match(video, /320×180, 24 fps, with sound/)
  const board = /Storyboard .*: (.+\.jpg)\n/.exec(video)[1]
  assert.ok((await sharp(board).metadata()).width > 0)
  assert.doesNotMatch(video, /test-secret|do-not-echo/)
  assert.equal(deps.localCalls(), 0)
  const request = JSON.parse(calls.find((c) => c.url.endsWith(':generateContent')).body)
  assert.equal(request.generationConfig, undefined, 'video keeps prose output')
  assert.match(request.contents[0].parts[1].text, /Markdown/)
  assert.match(request.contents[0].parts[1].text, /on-screen text \(OCR\), actions and motion/)
  assert.match(request.contents[0].parts[1].text, /Do not include a speech transcript/)
  t.mock.restoreAll()
  const audioCalls = mockApi(t, { text: TRANSCRIPT.replace('你好', KEY), state: 'ACTIVE' })
  const audio = await transcribeTool(settings, mediaDeps()).execute({ file: 'clip.mp4', speakers: false, language: 'zh' })
  const subtitles = /Subtitles saved: (.+\.srt)/.exec(audio)[1]
  assert.match(await readFile(subtitles, 'utf8'), /00:00:00,000 --> 00:00:02,000\n\[redacted\]/)
  assert.match(audio, /\[00:00-00:02\] \(happy\): \[redacted\]/)
  assert.doesNotMatch(audio, /Speaker 1/)
  assert.doesNotMatch(audio, /test-secret|do-not-echo/)
  const audioRequest = JSON.parse(audioCalls.find((c) => c.url.endsWith(':generateContent')).body)
  const { responseMimeType, responseJsonSchema } = audioRequest.generationConfig
  assert.equal(responseMimeType, 'application/json')
  assert.equal(responseJsonSchema.type, 'object')
  assert.equal(responseJsonSchema.properties.segments.type, 'array')
  const segmentSchema = responseJsonSchema.properties.segments.items
  assert.deepEqual(segmentSchema.required, ['start', 'end', 'speaker', 'text'])
  assert.deepEqual(Object.keys(segmentSchema.properties), ['start', 'end', 'speaker', 'text', 'tone'])
  const prompt = audioRequest.contents[0].parts[1].text
  assert.match(prompt, /JSON segments/)
  assert.match(prompt, /Do not distinguish speakers/)
  assert.match(prompt, /original language \(zh\)/)
})

test('media engines: structured segments produce speakers, tone, fractional timestamps and SRT', async (t) => {
  const { settings } = await fixture(t)
  settings.gemini.apiKey = KEY
  const segments = [
    { start: 0.125, end: 1.875, speaker: 1, text: '你好', tone: 'happy' },
    { start: 2, end: 3, speaker: 2, text: 'Hello' },
  ]
  mockApi(t, { text: JSON.stringify({ segments }), state: 'ACTIVE' })
  const deps = mediaDeps()
  const result = await transcribeTool(settings, deps).execute({ file: 'clip.mp4' })
  assert.match(result, /\[00:00-00:01\] Speaker 1 \(happy\): 你好/)
  assert.match(result, /\[00:02-00:03\] Speaker 2: Hello/)
  const path = /Subtitles saved: (.+\.srt)/.exec(result)[1]
  const srt = await readFile(path, 'utf8')
  assert.match(srt, /00:00:00,125 --> 00:00:01,875\nSpeaker 1: 你好/)
  assert.match(srt, /00:00:02,000 --> 00:00:03,000\nSpeaker 2: Hello/)
  assert.equal(deps.localCalls(), 0)
})

test('media engines: invalid structured segments fall back locally without leaking response text', async (t) => {
  const invalid = [
    'not JSON', '```json\n' + TRANSCRIPT + '\n```', '{}', '{"segments":{}}',
    ...[null, { start: '0' }, { start: -1 }, { end: 0 }, { end: Infinity },
      { speaker: 0 }, { speaker: 1.5 }, { speaker: 'Alice' }, { text: '' }, { text: 3 }, { tone: 3 },
    ].map((overrides) => JSON.stringify({ segments: [overrides === null ? null : { ...SEGMENTS[0], text: KEY, ...overrides }] })),
  ]
  // A normal segment with all fields omitted must also be rejected.
  invalid.push('{"segments":[{}]}')
  for (const [index, text] of invalid.entries()) {
    await t.test(`invalid response ${index}`, async (t) => {
      const { settings } = await fixture(t)
      settings.gemini.apiKey = KEY
      const calls = mockApi(t, { text, state: 'ACTIVE' })
      const deps = mediaDeps()
      const result = await transcribeTool(settings, deps).execute({ file: 'clip.mp4' })
      assert.match(result, /^Gemini unavailable; using local: Google returned an unreadable response\nFile/)
      assert.match(result, /local words/)
      assert.doesNotMatch(result, /test-secret|do-not-echo/)
      assert.equal(deps.localCalls(), 1)
      assert.equal(calls.at(-1).method, 'DELETE')
    })
  }
})

test('media engines: an empty structured transcript reports silence without falling back', async (t) => {
  const { settings } = await fixture(t)
  settings.gemini.apiKey = KEY
  const calls = mockApi(t, { text: '{"segments":[]}', state: 'ACTIVE' })
  const deps = mediaDeps()
  const result = await transcribeTool(settings, deps).execute({ file: 'clip.mp4' })
  assert.match(result, /analysed by Gemini/)
  assert.match(result, /No speech found\.$/)
  assert.doesNotMatch(result, /unavailable|Subtitles saved/)
  assert.equal(deps.localCalls(), 0)
  assert.equal(calls.at(-1).method, 'DELETE')
})

test('media engines: malformed audio, key-file failures and Chinese copy fall back locally', async (t) => {
  const { settings, dir } = await fixture(t)
  settings.gemini.apiKey = KEY
  mockApi(t, { text: 'not subtitles', state: 'ACTIVE' })
  const deps = mediaDeps()
  assert.match(await transcribeTool(settings, deps).execute({ file: 'clip.mp4' }), /^Gemini unavailable; using local: Google returned an unreadable response\nFile/)
  settings.gemini.apiKey = undefined
  settings.gemini.keyFile = dir
  settings.html.lang = 'zh-CN'
  assert.match(await transcribeTool(settings, deps).execute({ file: 'clip.mp4' }), /^Gemini 不可用，已改用本地处理：无法读取 Gemini 密钥文件\nFile/)
  assert.match(transcribeTool(settings, deps).description, /上传到 Google/)
})

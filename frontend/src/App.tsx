'use client'

import { useEffect, useRef, useState } from 'react'
import { TextRotate } from './components/ui/text-rotate'
import { GooeyText } from './components/ui/gooey-text-morphing'
import Floating, { FloatingElement } from './components/ui/parallax-floating'

// ── Nav ──────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav className="fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-8 px-6 py-2.5 rounded-full border border-white/10 bg-black/60 backdrop-blur-md">
      <a href="#hero" className="text-white/80 hover:text-white text-sm font-medium transition-colors">Home</a>
      <a href="#showcase" className="text-white/80 hover:text-white text-sm font-medium transition-colors">How it works</a>
      <a href="#architecture" className="text-white/80 hover:text-white text-sm font-medium transition-colors">Architecture</a>
      <a href="#demo" className="text-white/80 hover:text-white text-sm font-medium transition-colors">Demo</a>
      <a
        href="https://github.com/BonC-Dev/nileskv"
        target="_blank"
        rel="noreferrer"
        className="ml-2 px-4 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300 text-sm font-medium hover:bg-amber-400/20 transition-colors"
      >
        GitHub
      </a>
    </nav>
  )
}

// ── Hero ─────────────────────────────────────────────────────────────────────

const HERO_IMAGES = [
  { src: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=400&q=80', depth: 2, style: 'top-[10%] left-[5%] w-36 h-36 rounded-xl' },
  { src: 'https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=400&q=80', depth: 3, style: 'top-[20%] right-[6%] w-44 h-44 rounded-2xl' },
  { src: 'https://images.unsplash.com/photo-1510915228340-29c85a43dcfe?w=400&q=80', depth: 1.5, style: 'bottom-[18%] left-[8%] w-40 h-40 rounded-xl' },
  { src: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400&q=80', depth: 2.5, style: 'bottom-[10%] right-[10%] w-36 h-36 rounded-2xl' },
  { src: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400&q=80', depth: 1, style: 'top-[45%] left-[2%] w-28 h-28 rounded-xl' },
]

function Hero() {
  return (
    <section id="hero" className="relative min-h-screen flex items-center justify-center overflow-hidden bg-black">
      <Floating sensitivity={0.8} easingFactor={0.04}>
        {HERO_IMAGES.map((img, i) => (
          <FloatingElement key={i} depth={img.depth} className={img.style}>
            <img
              src={img.src}
              alt=""
              className="w-full h-full object-cover opacity-30 hover:opacity-50 transition-opacity duration-500"
              loading="lazy"
            />
          </FloatingElement>
        ))}
      </Floating>

      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-4xl mx-auto">
        <div className="mb-4 inline-flex items-center gap-2 px-3 py-1 rounded-full border border-amber-400/30 bg-amber-400/8 text-amber-300 text-xs font-mono tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          7μs proof verification
        </div>

        <h1 className="text-6xl md:text-8xl font-light tracking-tight text-white mb-2 leading-none">
          NilesKV
        </h1>

        <div className="flex items-center justify-center h-16 text-2xl md:text-3xl font-light text-white/60 overflow-hidden">
          <span className="mr-3 text-amber-400/80">A KV store that</span>
          <TextRotate
            texts={['proves itself.', 'commits truth.', 'never lies.', 'signs everything.', 'stays honest.']}
            rotationInterval={2200}
            staggerDuration={0.04}
            staggerFrom="first"
            splitBy="characters"
            mainClassName="text-white font-medium"
            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
          />
        </div>

        <p className="mt-6 text-white/38 text-base max-w-xl leading-relaxed font-light">
          Content-addressable storage with Merkle tree proofs, Write-Ahead Log,
          and a Git-style commit DAG. Every insert is cryptographically sealed.
        </p>

        <div className="mt-10 flex items-center gap-4">
          <a
            href="#demo"
            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors"
          >
            Try it
          </a>
          <a
            href="#showcase"
            className="px-6 py-2.5 rounded-full border border-white/20 text-white/80 text-sm font-medium hover:border-white/40 transition-colors"
          >
            How it works
          </a>
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 text-white/20">
        <span className="text-xs font-mono tracking-widest uppercase">scroll</span>
        <div className="w-px h-10 bg-gradient-to-b from-white/20 to-transparent" />
      </div>
    </section>
  )
}

// ── Ticker ────────────────────────────────────────────────────────────────────

const TICKER_TERMS = [
  'SHA-256', 'Merkle Tree', 'Write-Ahead Log', 'Commit DAG',
  'Content-Addressable', 'Cryptographic Proof', 'Immutable History',
  'Zero Dependencies', '7μs Verify', '13,800 inserts/sec',
  'Version Control', 'Hash Chain', 'WAL Replay', 'Root Hash',
]

function Ticker() {
  const doubled = [...TICKER_TERMS, ...TICKER_TERMS]
  return (
    <div className="relative border-y border-white/8 bg-black overflow-hidden py-4">
      <div
        className="flex gap-12 whitespace-nowrap"
        style={{ animation: 'ticker 28s linear infinite' }}
      >
        {doubled.map((t, i) => (
          <span key={i} className="text-white/25 text-sm font-mono tracking-widest uppercase flex items-center gap-12">
            {t}
            <span className="text-amber-400/40">*</span>
          </span>
        ))}
      </div>
      <style>{`@keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
    </div>
  )
}

// ── Showcase ──────────────────────────────────────────────────────────────────

const STEPS = [
  {
    num: '01',
    title: 'Insert',
    body: 'Every key-value pair is SHA-256 hashed and appended to the Write-Ahead Log. No data is ever overwritten.',
    code: `niles.set('user:42', { name: 'Niles', role: 'admin' })\n// WAL entry appended, hash computed`,
  },
  {
    num: '02',
    title: 'Commit',
    body: 'Pending WAL entries are folded into a Merkle tree. The root hash becomes a commit node in the DAG, pointing to its parent.',
    code: `niles.commit()\n// Merkle root: a3f8c2...\n// Commit: 7b19e0... -> parent: 4d22a1...`,
  },
  {
    num: '03',
    title: 'Prove',
    body: 'Request a cryptographic Merkle proof for any key. Anyone with the root hash can verify it in 7 microseconds, no trust required.',
    code: `const proof = niles.prove('user:42')\nniles.verify(proof, rootHash)\n// true -- 0.007ms`,
  },
]

function Showcase() {
  const [active, setActive] = useState(0)

  return (
    <section id="showcase" className="bg-black py-28 px-6">
      <div className="max-w-5xl mx-auto">
        <p className="text-amber-400/70 text-xs font-mono tracking-widest uppercase mb-3">How it works</p>
        <h2 className="text-4xl font-light text-white mb-16">Three operations. Infinite proof.</h2>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-3">
            {STEPS.map((s, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={`text-left p-6 rounded-2xl border transition-all duration-300 ${active === i
                  ? 'border-amber-400/40 bg-amber-400/6'
                  : 'border-white/8 bg-white/2 hover:border-white/16'}`}
              >
                <span className="text-amber-400/60 text-xs font-mono">{s.num}</span>
                <h3 className={`text-lg font-medium mt-1 ${active === i ? 'text-white' : 'text-white/60'}`}>{s.title}</h3>
                <p className="text-white/40 text-sm leading-relaxed mt-2">{s.body}</p>
              </button>
            ))}
          </div>

          <div className="flex items-center">
            <div className="w-full rounded-2xl border border-white/10 bg-white/3 p-6 font-mono text-sm">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
                <span className="ml-2 text-white/20 text-xs">nileskv</span>
              </div>
              <pre className="text-green-400/80 whitespace-pre-wrap text-xs leading-relaxed">
                {STEPS[active].code}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Architecture ──────────────────────────────────────────────────────────────

const SPECS = [
  { label: 'Hash function', value: 'SHA-256 (Node crypto)' },
  { label: 'Tree structure', value: 'Binary Merkle with paired leaves' },
  { label: 'Durability', value: 'Write-Ahead Log with fsync' },
  { label: 'History', value: 'Git-style commit DAG' },
  { label: 'API', value: 'REST over HTTP (Express)' },
  { label: 'Dependencies', value: 'Zero runtime deps' },
]

function Architecture() {
  return (
    <section id="architecture" className="bg-black border-t border-white/8 py-28 px-6">
      <div className="max-w-5xl mx-auto">
        <p className="text-amber-400/70 text-xs font-mono tracking-widest uppercase mb-3">Architecture</p>

        <div className="h-24 flex items-center mb-12">
          <GooeyText
            texts={['SHA-256.', 'Merkle Tree.', 'Write-Ahead Log.', 'Commit DAG.', 'Hand-built.']}
            morphTime={1.2}
            cooldownTime={2.5}
            textClassName="text-4xl md:text-5xl font-light text-white"
          />
        </div>

        <div className="grid md:grid-cols-2 gap-x-16 gap-y-0">
          {SPECS.map((s, i) => (
            <div key={i} className="flex items-baseline justify-between py-4 border-b border-white/8">
              <span className="text-white/40 text-sm">{s.label}</span>
              <span className="text-white/80 text-sm font-mono">{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Demo ──────────────────────────────────────────────────────────────────────

const API_BASE = 'https://nileskv.me/api'

type Line = { text: string; type: 'cmd' | 'out' | 'err' }

function Demo() {
  const [lines, setLines] = useState<Line[]>([
    { text: '# NilesKV live demo -- nileskv.me', type: 'out' },
    { text: 'ready.', type: 'out' },
  ])
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const push = (l: Line) => setLines(prev => [...prev, l])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    push({ text: `$ ${label}`, type: 'cmd' })
    try {
      await fn()
    } catch (e: unknown) {
      push({ text: String(e), type: 'err' })
    }
    setBusy(false)
  }

  const doInsert = () => run('niles set demo:key "hello from the browser"', async () => {
    const r = await fetch(`${API_BASE}/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'demo:key', value: 'hello from the browser' }),
    })
    const d = await r.json()
    push({ text: JSON.stringify(d, null, 2), type: 'out' })
  })

  const doCommit = () => run('niles commit', async () => {
    const r = await fetch(`${API_BASE}/commit`, { method: 'POST' })
    const d = await r.json()
    push({ text: JSON.stringify(d, null, 2), type: 'out' })
  })

  const doProve = () => run('niles prove demo:key', async () => {
    const r = await fetch(`${API_BASE}/prove/demo:key`)
    const d = await r.json()
    push({ text: JSON.stringify(d, null, 2), type: 'out' })
  })

  const doClear = () => {
    setLines([{ text: '# cleared', type: 'out' }])
  }

  return (
    <section id="demo" className="bg-black border-t border-white/8 py-28 px-6">
      <div className="max-w-5xl mx-auto">
        <p className="text-amber-400/70 text-xs font-mono tracking-widest uppercase mb-3">Live demo</p>
        <h2 className="text-4xl font-light text-white mb-10">Run it now.</h2>

        <div className="rounded-2xl border border-white/10 bg-[#080808] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/8">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="ml-3 text-white/20 text-xs font-mono">nileskv terminal</span>
            </div>
            <button onClick={doClear} className="text-white/20 hover:text-white/50 text-xs font-mono transition-colors">clear</button>
          </div>

          <div className="h-64 overflow-y-auto p-5 font-mono text-xs leading-relaxed space-y-1">
            {lines.map((l, i) => (
              <div key={i} className={
                l.type === 'cmd' ? 'text-amber-400' :
                l.type === 'err' ? 'text-red-400' :
                'text-white/50'
              }>
                {l.text}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="flex gap-3 px-5 py-4 border-t border-white/8">
            {[
              { label: '1. Insert', fn: doInsert },
              { label: '2. Commit', fn: doCommit },
              { label: '3. Prove', fn: doProve },
            ].map(({ label, fn }) => (
              <button
                key={label}
                onClick={fn}
                disabled={busy}
                className="px-4 py-2 rounded-lg border border-white/12 text-white/70 text-xs font-mono hover:border-amber-400/40 hover:text-amber-300 disabled:opacity-40 transition-all"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const STATS = [
  { value: '13,800', unit: 'inserts/sec', label: 'Throughput' },
  { value: '7', unit: 'μs', label: 'Proof verification' },
  { value: '202', unit: 'ms', label: 'Merkle commit (1k docs)' },
  { value: '613', unit: 'req/sec', label: 'API throughput' },
]

function Stats() {
  return (
    <section className="bg-black border-t border-white/8 py-28 px-6">
      <div className="max-w-5xl mx-auto">
        <p className="text-amber-400/70 text-xs font-mono tracking-widest uppercase mb-12">Benchmarks</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {STATS.map((s, i) => (
            <div key={i}>
              <div className="flex items-baseline gap-1">
                <span className="text-5xl font-light text-white tracking-tight">{s.value}</span>
                <span className="text-amber-400/70 text-lg font-mono">{s.unit}</span>
              </div>
              <div className="text-white/30 text-sm mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-black border-t border-white/8 py-10 px-6">
      <div className="max-w-5xl mx-auto flex items-center justify-between">
        <div className="font-mono text-white/30 text-sm">NilesKV</div>
        <div className="flex items-center gap-6">
          <a href="https://github.com/BonC-Dev/nileskv" target="_blank" rel="noreferrer"
            className="text-white/30 hover:text-white/70 text-sm transition-colors">GitHub</a>
          <a href="#demo" className="text-white/30 hover:text-white/70 text-sm transition-colors">Demo</a>
        </div>
        <div className="text-white/15 text-xs font-mono">
          nileskv.me
        </div>
      </div>
    </footer>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div className="bg-black min-h-screen" style={{ fontFamily: "'Inter', sans-serif" }}>
      <Nav />
      <Hero />
      <Ticker />
      <Showcase />
      <Architecture />
      <Demo />
      <Stats />
      <Footer />
    </div>
  )
}

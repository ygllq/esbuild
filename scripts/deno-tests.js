// To run this, you must first build the Deno package with "make platform-deno"
import * as esbuildNative from '../deno/mod.js'
import * as esbuildWASM from '../deno/wasm.js'
import * as path from 'https://deno.land/std@0.95.0/path/mod.ts'
import * as asserts from 'https://deno.land/std@0.95.0/testing/asserts.ts'

const __dirname = path.dirname(path.fromFileUrl(import.meta.url))
const rootTestDir = path.join(__dirname, '.deno-tests')
const wasmModule = await WebAssembly.compile(await Deno.readFile(path.join(__dirname, '..', 'deno', 'esbuild.wasm')))
let testDidFail = false

try {
  Deno.removeSync(rootTestDir, { recursive: true })
} catch {
}
Deno.mkdirSync(rootTestDir, { recursive: true })

function test(name, backends, fn) {
  for (const backend of backends) {
    switch (backend) {
      case 'native':
        Deno.test(name + '-native', async () => {
          let testDir = path.join(rootTestDir, name + '-native')
          await Deno.mkdir(testDir, { recursive: true })
          try {
            await fn({ esbuild: esbuildNative, testDir })
            await Deno.remove(testDir, { recursive: true }).catch(() => null)
          } catch (e) {
            testDidFail = true
            throw e
          } finally {
            esbuildNative.stop()
          }
        })
        break

      case 'wasm-main':
        Deno.test(name + '-wasm-main', async () => {
          let testDir = path.join(rootTestDir, name + '-wasm-main')
          await esbuildWASM.initialize({ wasmModule, worker: false })
          await Deno.mkdir(testDir, { recursive: true })
          try {
            await fn({ esbuild: esbuildWASM, testDir })
            await Deno.remove(testDir, { recursive: true }).catch(() => null)
          } catch (e) {
            testDidFail = true
            throw e
          } finally {
            esbuildWASM.stop()
          }
        })
        break

      case 'wasm-worker':
        Deno.test(name + '-wasm-worker', async () => {
          let testDir = path.join(rootTestDir, name + '-wasm-worker')
          await esbuildWASM.initialize({ wasmModule, worker: true })
          await Deno.mkdir(testDir, { recursive: true })
          try {
            await fn({ esbuild: esbuildWASM, testDir })
            await Deno.remove(testDir, { recursive: true }).catch(() => null)
          } catch (e) {
            testDidFail = true
            throw e
          } finally {
            esbuildWASM.stop()
          }
        })
        break
    }
  }
}

window.addEventListener("unload", (e) => {
  if (testDidFail) {
    console.error(`❌ deno tests failed`)
  } else {
    console.log(`✅ deno tests passed`)
    try {
      Deno.removeSync(rootTestDir, { recursive: true })
    } catch {
      // root test dir possibly already removed, so ignore
    }
  }

  // Loading a WebAssembly module in V8 adds a background job for JIT
  // compilation. If we don't explicitly exit here, then Deno will burn
  // CPU for around 10 seconds after exit while the compiler uselessly
  // generates the fully-optimized WebAssembly code after we're already
  // done running. This is a bug in Deno.
  Deno.exit(testDidFail ? 1 : 0);
})

// This test doesn't run in WebAssembly because it requires file system access
test("basicBuild", ['native'], async ({ esbuild, testDir }) => {
  const input = path.join(testDir, 'in.ts')
  const dep = path.join(testDir, 'dep.ts')
  const output = path.join(testDir, 'out.ts')
  await Deno.writeTextFile(input, 'import dep from "./dep.ts"; export default dep === 123')
  await Deno.writeTextFile(dep, 'export default 123')
  await esbuild.build({
    entryPoints: [input],
    bundle: true,
    outfile: output,
    format: 'esm',
  })
  const result = await import(path.toFileUrl(output))
  asserts.assertStrictEquals(result.default, true)
})

test("basicPlugin", ['native', 'wasm-main', 'wasm-worker'], async ({ esbuild }) => {
  const build = await esbuild.build({
    entryPoints: ['<entry>'],
    bundle: true,
    format: 'esm',
    write: false,
    plugins: [{
      name: 'plug',
      setup(build) {
        build.onResolve({ filter: /^<.*>$/ }, args => ({ path: args.path, namespace: '<>' }))
        build.onLoad({ filter: /^<entry>$/ }, () => ({ contents: `import dep from "<dep>"; export default dep === 123` }))
        build.onLoad({ filter: /^<dep>$/ }, () => ({ contents: `export default 123` }))
      },
    }],
  })
  const result = await import('data:application/javascript;base64,' + btoa(build.outputFiles[0].text))
  asserts.assertStrictEquals(result.default, true)
})

test("basicTransform", ['native', 'wasm-main', 'wasm-worker'], async ({ esbuild }) => {
  const ts = 'let x: number = 1+2'
  const result = await esbuild.transform(ts, { loader: 'ts' })
  asserts.assertStrictEquals(result.code, 'let x = 1 + 2;\n')
})

// This test doesn't run in WebAssembly because of a stack overflow
test("largeTransform", ['native'], async ({ esbuild }) => {
  // This should be large enough to be bigger than Deno's write buffer
  let x = '0'
  for (let i = 0; i < 1000; i++)x += '+' + i
  x += ','
  let y = 'return['
  for (let i = 0; i < 1000; i++)y += x
  y += ']'
  const result = await esbuild.build({
    stdin: {
      contents: y,
    },
    write: false,
    minify: true,
  })
  asserts.assertStrictEquals(result.outputFiles[0].text, y.slice(0, -2) + '];\n')
})

test("analyzeMetafile", ['native', 'wasm-main', 'wasm-worker'], async ({ esbuild }) => {
  const result = await esbuild.analyzeMetafile({
    outputs: {
      'out.js': {
        bytes: 4096,
        inputs: {
          'in.js': {
            bytesInOutput: 1024,
          },
        },
      },
    },
  })
  asserts.assertStrictEquals(result, `
  out.js    4.0kb  100.0%
   └ in.js  1.0kb   25.0%
`)
})

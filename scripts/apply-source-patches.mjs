#!/usr/bin/env node
// Apply the Source Wasm patch set to a user-provided engine tree.
// Does not ship or clone the leaked source.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || process.env.SOURCE_ENGINE_ROOT;
if (!root) {
  console.error('usage: apply-source-patches.mjs <engine-tree>');
  process.exit(2);
}

function apply(rel, find, replace, label) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) throw new Error(`missing ${rel} (is this a nillerusr/ToGL 2017-era tree?)`);
  const before = readFileSync(abs, 'utf8');
  if (before.includes(replace) || before.includes('SOURCE_WASM_PATCH_' + label)) {
    console.log(`skip ${label}`);
    return false;
  }
  if (!before.includes(find)) {
    throw new Error(`cannot apply ${label}: expected text not in ${rel}`);
  }
  writeFileSync(abs, before.replace(find, replace));
  console.log(`applied ${label}`);
  return true;
}

if (!existsSync(path.join(root, 'wscript')) || !existsSync(path.join(root, 'togles'))) {
  throw new Error(`${root} does not look like a Source 2017 ToGL/TOGLES tree`);
}

let n = 0;
n += apply(
  'togles/linuxwin/cglmbuffer.cpp',
  'bool g_bDisableStaticBuffer = true; //( Plat_GetCommandLineA() ) ? ( strstr( Plat_GetCommandLineA(), "-gl_disable_static_buffer" ) != NULL ) : false;',
  'bool g_bDisableStaticBuffer = false; // SOURCE_WASM_PATCH_static_gl_buffers',
  'static_gl_buffers'
) ? 1 : 0;

n += apply(
  'engine/sys_dll.cpp',
  `#elif defined(LINUX)
	const int fd = open("/proc/meminfo", O_RDONLY);`,
  `#elif defined(EMSCRIPTEN)
	memsize = 512ull * 1024ull * 1024ull;
#elif defined(LINUX)
	const int fd = open("/proc/meminfo", O_RDONLY);`,
  'emscripten_memsize'
) ? 1 : 0;

n += apply(
  'materialsystem/ctexture.cpp',
  '	const int minSize = 2 * 1024 * 1024;	// Uses 2MB min to avoid fragmentation',
  `#ifdef EMSCRIPTEN
	const int minSize = 1; // SOURCE_WASM_PATCH_no_2mb_floor
#else
	const int minSize = 2 * 1024 * 1024;	// Uses 2MB min to avoid fragmentation
#endif`,
  'no_2mb_floor'
) ? 1 : 0;

n += apply(
  'vpklib/packedstore.cpp',
  `#ifdef IS_WINDOWS_PC
				if ( nDesiredPos != fHandle.m_nCurOfs )
					SetFilePointer ( fHandle.m_hFileHandle, nDesiredPos, NULL,  FILE_BEGIN); 
				ReadFile( fHandle.m_hFileHandle, pOutData, nNumBytes, (LPDWORD) &nRead, NULL );
#else
				m_pFileSystem->Seek( fHandle.m_hFileHandle, nDesiredPos, FILESYSTEM_SEEK_HEAD );
				nRead = m_pFileSystem->Read( pOutData, nNumBytes, fHandle.m_hFileHandle );
#endif`,
  `#if defined(EMSCRIPTEN)
				m_pFileSystem->Seek( fHandle.m_hFileHandle, nDesiredPos, FILESYSTEM_SEEK_HEAD );
				nRead = m_pFileSystem->Read( pOutData, nNumBytes, fHandle.m_hFileHandle );
#elif defined(IS_WINDOWS_PC)
				if ( nDesiredPos != fHandle.m_nCurOfs )
					SetFilePointer ( fHandle.m_hFileHandle, nDesiredPos, NULL,  FILE_BEGIN); 
				ReadFile( fHandle.m_hFileHandle, pOutData, nNumBytes, (LPDWORD) &nRead, NULL );
#else
				m_pFileSystem->Seek( fHandle.m_hFileHandle, nDesiredPos, FILESYSTEM_SEEK_HEAD );
				nRead = m_pFileSystem->Read( pOutData, nNumBytes, fHandle.m_hFileHandle );
#endif`,
  'packedstore_exact_io'
) ? 1 : 0;

n += apply(
  'wscript',
  `	grp.add_option('--togles', action = 'store_true', dest = 'TOGLES', default = False,
		help = 'build engine with ToGLES [default: %default]')`,
  `	grp.add_option('--togles', action = 'store_true', dest = 'TOGLES', default = False,
		help = 'build engine with ToGLES [default: %default]')

	grp.add_option('--emscripten', action = 'store_true', dest = 'EMSCRIPTEN', default = False,
		help = 'build engine with Emscripten / wasm [default: %default]')`,
  'wscript_emscripten_option'
) ? 1 : 0;

n += apply(
  'wscript',
  `	define_platform(conf)

	if conf.env.TOGLES:`,
  `	define_platform(conf)

	if getattr(conf.options, 'EMSCRIPTEN', False) or os.environ.get('EMSCRIPTEN'):
		conf.env.EMSCRIPTEN = True
		conf.env.append_unique('DEFINES', ['EMSCRIPTEN=1'])

	if conf.env.TOGLES:`,
  'wscript_emscripten_env'
) ? 1 : 0;

const launcher = path.join(root, 'launcher_main', 'wscript');
if (existsSync(launcher)) {
  n += apply(
    'launcher_main/wscript',
    `	install_path = bld.env.BINDIR
	bld(`,
    `	install_path = bld.env.BINDIR
	if getattr(bld.env, 'EMSCRIPTEN', False) or os.environ.get('EMSCRIPTEN'):
		bld.env.append_unique('LINKFLAGS', [
			'-sMODULARIZE=1',
			'-sEXPORT_NAME=createSourceEngineModule',
			'-sEXPORTED_RUNTIME_METHODS=["FS","HEAPU8","HEAP8","ccall","cwrap","callMain"]',
			'-sNO_EXIT_RUNTIME=1',
			'-sSTACK_SIZE=8388608',
			'-sALLOW_MEMORY_GROWTH=1'
		])
	bld(`,
    'launcher_factory'
  ) ? 1 : 0;
}

console.log(`source patches applied: ${n} change(s) in ${root}`);

const { createHash } = require('node:crypto');

// This is the published just-bash@3.6.0 browser artifact, not a moving Git SHA.
// Upgrades must rerun the compatibility/command tests and update this fingerprint.
const BROWSER_SHA256 = '38f1ad1e3283980ecdf68cede8a4eed028c6dff6e8c31793dec1e0af529c446e';
const BROWSER_PATH = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

// compareFileIdentity only consumes stat and realpath. Resolve the parent to
// preserve the final link's canonical spelling, including when it dangles.
// The helper still requires stable identities to prove two existing aliases
// differ; this does not weaken upstream's conservative unknown result.
const LINK_IDENTITY_FS = `
function __piBashLinkIdentityFs(fs) {
  return {
    stat: (path) => fs.lstat(path),
    realpath: async (path) => {
      const slash = path.lastIndexOf('/');
      const parent = await fs.realpath(path.slice(0, slash) || '/');
      return (parent === '/' ? '' : parent) + '/' + path.slice(slash + 1);
    },
  };
}
async function __piBashEntryExists(fs, path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || /^ENOENT\\b/.test(String(error?.message))) return false;
    throw error;
  }
}
`;

function isBashBrowser(filename) {
  return BROWSER_PATH.test(filename);
}

function adaptBashBrowser(source, cryptoModule) {
  if (createHash('sha256').update(source).digest('hex') !== BROWSER_SHA256) {
    throw new Error('The just-bash browser artifact changed. Review the native compatibility adapter before upgrading.');
  }
  const edits = [
    ['globalThis.crypto.subtle.digest(', '__piBashDigest('],
    ['crypto.getRandomValues(', '__piBashGetRandomValues('],
    // cp/mv ultimately copy or rename the link inode. Their source prechecks
    // must not follow it first, or dangling links fail before reaching our FS.
    ['let b=t.fs.resolvePath(t.cwd,g),y=await t.fs.stat(b),w=u;',
      'let b=t.fs.resolvePath(t.cwd,g),y=await t.fs.lstat(b),w=u;'],
    ['let g=t.fs.resolvePath(t.cwd,m),b=await t.fs.stat(g),y=c;',
      'let g=t.fs.resolvePath(t.cwd,m),b=await t.fs.lstat(g),y=c;'],
    // Keep upstream's conservative identity comparison. For link sources, feed
    // it lstat identities on both sides so dangling links are existing inodes,
    // while regular-file copying retains its original dereference behavior.
    ['let x=await ya(t.fs,b,w);',
      'let x=await ya(y.isSymbolicLink?__piBashLinkIdentityFs(t.fs):t.fs,b,w);'],
    ['let w=await ya(t.fs,g,y);',
      'let w=await ya(b.isSymbolicLink?__piBashLinkIdentityFs(t.fs):t.fs,g,y);'],
    // -n protects an existing destination inode, including a dangling link.
    ['if(s)try{await t.fs.stat(w);continue}catch{}let x=',
      'if(s)try{await t.fs.lstat(w);continue}catch{}let x='],
    ['if(s)try{await t.fs.stat(y);continue}catch{}let w=',
      'if(s)try{await t.fs.lstat(y);continue}catch{}let w='],
    // rm removes the final entry, including dangling and directory links.
    ['let f=t.fs.resolvePath(t.cwd,u);if((await t.fs.stat(f)).isDirectory&&!r)',
      'let f=t.fs.resolvePath(t.cwd,u);if((await t.fs.lstat(f)).isDirectory&&!r)'],
    // ln -f must see a dangling destination before replacing it. Hard-link
    // sources likewise name an inode; only ENOENT means it is absent.
    ['let l=o[0],a=o[1],c=t.fs.resolvePath(t.cwd,a);if(await t.fs.exists(c))',
      'let l=o[0],a=o[1],c=t.fs.resolvePath(t.cwd,a);if(await __piBashEntryExists(t.fs,c))'],
    ['let f=t.fs.resolvePath(t.cwd,l);if(!await t.fs.exists(f))',
      'let f=t.fs.resolvePath(t.cwd,l);if(!await __piBashEntryExists(t.fs,f))'],
  ];
  for (const [original, replacement] of edits) {
    if (source.split(original).length !== 2) throw new Error(`Unexpected just-bash compatibility boundary: ${original}`);
    source = source.replace(original, replacement);
  }
  // These bindings belong only to the shell module: no Buffer or crypto globals
  // are installed, and arbitrary node: imports remain unsupported by Metro.
  return 'import { Buffer } from "buffer";\n'
    + `import { digest as __piBashDigest, getRandomValues as __piBashGetRandomValues } from ${JSON.stringify(cryptoModule)};\n`
    + LINK_IDENTITY_FS
    + source;
}

module.exports = { BROWSER_SHA256, isBashBrowser, adaptBashBrowser };

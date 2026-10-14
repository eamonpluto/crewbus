// Regenerate Tauri desktop icons from the repo brand artwork.
// Run from apps/desktop/: node scripts/regenerate-icons.mjs
// Reads ../../assets/brand/crewbus-app-icon-1024-rounded.png (1024x1024,
// transparent rounded corners per the brand sheet) and resizes with
// System.Drawing (Windows PowerShell) into src-tauri/icons/ PNG sizes.
// .ico/.icns are regenerated separately with Pillow (no cross-platform
// encoder in this script):
//   python -c "from PIL import Image; im=Image.open('../../assets/brand/crewbus-app-icon-1024-rounded.png'); im.save('../src-tauri/icons/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]); im.save('../src-tauri/icons/icon.icns')"
// StoreLogo/Windows-tile PNGs ARE handled here (square resizes above).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const icons = path.join(desktop, 'src-tauri', 'icons');
const src = path.join(repo, 'assets', 'brand', 'crewbus-app-icon-1024-rounded.png');

if (!fs.existsSync(src)) {
  console.error('brand source missing: ' + src);
  process.exit(1);
}

// [file, size] — square sizes mirror the previous icon set layout.
const targets = [
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['256x256.png', 256],
  ['512x512.png', 512],
  ['icon.png', 512],
  // Windows store/logo tiles + StoreLogo (square crops of the brand icon).
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
  ['StoreLogo.png', 50],
];

const lines = targets.map(([f, s]) => {
  const out = path.join(icons, f).replace(/'/g, "''");
  return `$src='${src.replace(/'/g, "''")}'; $dst='${out}'; ` +
    `$im=[System.Drawing.Image]::FromFile($src); ` +
    `$b=New-Object System.Drawing.Bitmap(${s},${s}); ` +
    `$g=[System.Drawing.Graphics]::FromImage($b); ` +
    `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; ` +
    `$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality; ` +
    `$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality; ` +
    `$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality; ` +
    `$g.Clear([System.Drawing.Color]::Transparent); ` +
    `$g.DrawImage($im,0,0,${s},${s}); $g.Dispose(); $im.Dispose(); ` +
    `$b.Save($dst,[System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); ` +
    `Write-Output ('wrote ${f} ${s}x${s}')`;
});

const ps = `Add-Type -AssemblyName System.Drawing; ` + lines.join('; ');
execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

// iOS + Android trees: walk the existing PNGs, resize to each file's own
// current dimensions (sizes encode the platform contract).
function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(p);
  }
  return out;
}
const subtrees = ['ios', 'android'].map((d) => path.join(icons, d)).filter((d) => fs.existsSync(d));
const extra = subtrees.flatMap(collect).map((abs) => path.relative(icons, abs).replace(/\\/g, '/'));
if (extra.length) {
  const probe = extra.map((rel) => {
    const q = rel.replace(/'/g, "''");
    return `$w=(New-Object System.Drawing.Bitmap('${icons.replace(/'/g, "''")}/${q}')).Width; Write-Output ('${q}='+$w)`;
  }).join('; ');
  const dims = Object.fromEntries(
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; ${probe}`], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => { const i = l.lastIndexOf('='); return [l.slice(0, i), Number(l.slice(i + 1))]; })
  );
  const lines2 = extra.map((rel) => {
    const s = dims[rel] || 192;
    const q = rel.replace(/'/g, "''");
    return `$dst='${icons.replace(/'/g, "''")}/${q}'; ` +
      `$b=New-Object System.Drawing.Bitmap(${s},${s}); ` +
      `$g=[System.Drawing.Graphics]::FromImage($b); ` +
      `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; ` +
      `$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality; ` +
      `$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality; ` +
      `$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality; ` +
      `$g.Clear([System.Drawing.Color]::Transparent); ` +
      `$g.DrawImage($im0,0,0,${s},${s}); $g.Dispose(); ` +
      `$b.Save($dst,[System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); ` +
      `Write-Output ('wrote ${rel} ${s}x${s}')`;
  });
  const ps2 = `Add-Type -AssemblyName System.Drawing; $im0=[System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}'); ` +
    lines2.join('; ') + `; $im0.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps2], { stdio: 'inherit' });
}
console.log('icons regenerated from assets/brand/crewbus-app-icon-1024-rounded.png');

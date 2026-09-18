"""Synthetic books only; the dictionary fixture is the full upstream JMdict release."""
import base64
import hashlib
import json
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
paragraphs = ''.join(f'<p>段落{i:04d}。猫が学校で日本語を勉強しています。昨日は魚を食べました。</p>' for i in range(250))
body = '<h1>日本語テスト</h1><p><ruby>猫<rt>ねこ</rt></ruby>が好きです。</p><p>学校に行きます。食べました。</p><p><a href="#note">注を見る</a></p><table><tr><td>表の内容</td></tr></table><img src="cover.png" alt="Local cover"/>' + paragraphs + '<aside id="note">脚注の内容</aside>'
container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'

def epub(name, title, content, extra=None):
    opf = f'''<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title><dc:language>ja</dc:language><dc:identifier id="uid">urn:uuid:e2e-{name}</dc:identifier><meta name="cover" content="cover"/></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="cover" href="cover.png" media-type="image/png"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>'''
    ncx = f'<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>{title}</text></docTitle><navMap><navPoint id="ch1" playOrder="1"><navLabel><text>第一章</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>'
    with zipfile.ZipFile(root / name, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', container)
        z.writestr('OEBPS/content.opf', opf)
        z.writestr('OEBPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>日本語</title></head><body>' + content + '</body></html>')
        z.writestr('OEBPS/toc.ncx', ncx)
        z.writestr('OEBPS/style.css', 'p {line-height:1.7} ruby {ruby-position:over} .vertical {writing-mode:vertical-rl}')
        z.writestr('OEBPS/cover.png', png)
        for key, value in (extra or {}).items():
            z.writestr(key, value)

epub('japanese.epub', 'E2E Japanese EPUB', body)
epub('malicious.epub', 'E2E Hostile EPUB', '<h1>安全な本文</h1><script>window.__epubExecuted=true</script><img src="http://127.0.0.1:4173/probe-image" onerror="window.__epubExecuted=true"/><iframe src="http://127.0.0.1:4173/probe-frame"></iframe><a href="javascript:alert(1)">危険なリンク</a><p style="background-image:url(http://127.0.0.1:4173/probe-css)">残る文章</p><style>@import "http://127.0.0.1:4173/probe-import";</style>')
epub('traversal.epub', 'E2E Reject Traversal', '<p>禁止</p>', {'../escape.txt': 'not allowed'})
(root / 'truncated.epub').write_bytes((root / 'japanese.epub').read_bytes()[:100])
(root / 'plain.txt').write_text('猫が好きです。\n学校で日本語を勉強しています。\n' + '\n'.join(f'行{i:04d} 読書を続けています。' for i in range(300)), encoding='utf-8')
with zipfile.ZipFile(root / 'htmlbook.htmlz', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', '<html><body><h1>E2E HTMLZ</h1><p><ruby>学校<rt>がっこう</rt></ruby>で読書します。</p></body></html>')
    z.writestr('metadata.opf', '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>E2E HTMLZ</dc:title></metadata></package>')
    z.writestr('style.css', 'p {font-weight:bold}')
    z.writestr('cover.jpg', png)
metadata = {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.iterdir() if p.is_file()}
(root / 'synthetic-fixtures.json').write_text(json.dumps(metadata, indent=2))

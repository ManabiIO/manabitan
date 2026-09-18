from pathlib import Path
p=Path('reader-fixture/apps/web/src/lib/functions/file-loaders/htmlz/load-htmlz.ts')
s=p.read_text()
old='    elementHtml: element.innerHTML,'
assert s.count(old)==1
s=s.replace(old,'''    // Reader pagination treats each top-level element as a section and renders
    // its innerHTML. Keep the complete HTMLZ body inside one section so root
    // text, paragraph/heading semantics and following siblings are preserved.
    elementHtml: element.outerHTML,''')
p.write_text(s)
p=Path('test/reader-web/make-fixtures.py')
s=p.read_text().replace("'<html><body><h1>E2E HTMLZ</h1><p><ruby>学校<rt>がっこう</rt></ruby>で読書します。</p></body></html>'", "'<html><body>導入の文章<h1>E2E HTMLZ</h1><p><ruby>学校<rt>がっこう</rt></ruby>で読書します。</p>末尾の文章</body></html>'")
p.write_text(s)

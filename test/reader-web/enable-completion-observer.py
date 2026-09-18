from pathlib import Path
p=Path('test/reader-web/run.mjs')
s=p.read_text()
old="await settings.setInputFiles('#dictionary-import-file-input', path.join(fixtures, 'JMdict_english.zip'));"
assert s.count(old)==1
s=s.replace(old,"await settings.evaluate(() => { globalThis.__manabitanImportCompletionSignalEnabled = true; }); "+old)
s=s.replace("    try {\n        const detail = await fn();", """    let deadline;
    try {
        const milliseconds = name.startsWith('manabitan: install') ? 660000 : 90000;
        const detail = await Promise.race([fn(), new Promise((_, reject) => {
            deadline = setTimeout(() => { const error = new Error('Test deadline exceeded: ' + name); error.name = 'TestDeadlineError'; reject(error); }, milliseconds);
        })]);""")
s=s.replace("        await save();\n        return false;\n    }\n}", "        await save();\n        if (error?.name === 'TestDeadlineError') { throw error; }\n        return false;\n    } finally { clearTimeout(deadline); }\n}")
p.write_text(s)

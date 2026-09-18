from pathlib import Path
import json,base64,gzip,hashlib
raw=gzip.decompress(base64.b64decode(''.join(Path(f'research/web-source-{i}.b64').read_text().strip() for i in (1,2,3)),validate=True))
assert hashlib.sha256(raw).hexdigest()=='3cc4ac5a5fb0a8bd16a9edcf43a34eaa3be9207c4a9bc7ec9661359154c29e88'
for entry in json.loads(raw):
    p=Path(entry['path']);assert p.as_posix().startswith(('ext/web/','web/')) and '..' not in p.parts
    p.parent.mkdir(parents=True,exist_ok=True);p.write_text(entry['content'])
p=Path('types/ext/text-scanner.d.ts');s=p.read_text();old='export type ConstructorDetails = {\n    api: API;'
assert old in s;s=s.replace(old,"export type ScannerApi = Pick<API, 'termsFind' | 'kanjiFind' | 'isTextLookupWorthy'>;\n\nexport type ConstructorDetails = {\n    api: ScannerApi;");p.write_text(s)
p=Path('ext/js/language/text-scanner.js');s=p.read_text();old="/** @type {import('../comm/api.js').API} */";assert old in s;s=s.replace(old,"/** @type {import('text-scanner').ScannerApi} */");p.write_text(s)
p=Path('types/ext/structured-content.d.ts');p.write_text(p.read_text()+'''
/** A host-local URL media adapter for the shared structured dictionary renderer. */
export interface UrlContentManager {
    loadMediaUrl(path: string, dictionary: string, loaded: (url: string) => void, failed: () => void): void;
    prepareLink(element: HTMLAnchorElement, href: string, internal: boolean): void;
    openMediaInTab(path: string, dictionary: string, window: Window): Promise<void>;
}
''')
p=Path('ext/js/display/structured-content-generator.js');s=p.read_text();s=s.replace("import('../templates/anki-template-renderer-content-manager.js').AnkiTemplateRendererContentManager}","import('../templates/anki-template-renderer-content-manager.js').AnkiTemplateRendererContentManager|import('structured-content').UrlContentManager}")
old='''                );
            }
        }

        return node;'''
new='''                );
            } else if ('loadMediaUrl' in this._contentManager) {
                this._contentManager.loadMediaUrl(
                    path, dictionary,
                    (url) => { this._setImageData(node, /** @type {HTMLImageElement} */ (image), imageBackground, url, false); },
                    () => { this._setImageData(node, /** @type {HTMLImageElement} */ (image), imageBackground, null, true); },
                );
            }
        }

        return node;'''
assert s.count(old)==1;s=s.replace(old,new)
s=s.replace("if (this._contentManager instanceof DisplayContentManager) {\n                const contentManager =", "if (this._contentManager instanceof DisplayContentManager || 'loadMediaUrl' in this._contentManager) {\n                const contentManager =")
p.write_text(s)
p=Path('ext/web/client.ts');s=p.read_text().replace('    open(): Promise<Status> {','    open(): Promise<Status> {\n        if (this.stopped) return Promise.reject(new WebRuntimeError(\'closed\', \'Dictionary runtime is closed\'));');p.write_text(s)

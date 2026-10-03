import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

export class Registry {
    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
        this.BOOT_ID_PATH = this.REGISTRY_DIR + '/boot-id';
    }

    // The shell disables the extension on every screen lock and enables it
    // again on unlock, so a new boot is told by the kernel's boot id, kept
    // next to the history, not by enable(). With no id stored yet nothing is
    // cleared: turning the option on must not wipe the history at the next
    // unlock.
    async recordBoot (clearIfNew) {
        const [, current] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
        const bootId = new TextDecoder().decode(current).trim();
        const file = Gio.file_new_for_path(this.BOOT_ID_PATH);

        let stored = null;
        try {
            const [contents] = await file.load_contents_async(null);
            stored = new TextDecoder().decode(contents).trim();
        }
        catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(e);
        }

        if (stored === bootId)
            return;

        if (clearIfNew && stored !== null)
            await this.clearCacheFolder();

        GLib.mkdir_with_parents(this.REGISTRY_DIR, 0o775);
        await file.replace_contents_bytes_async(new GLib.Bytes(bootId),
            null, false, Gio.FileCreateFlags.NONE, null);
    }

    write (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                const filename = this.getEntryFilename(entry);
                item.contents = filename;
                this.writeEntryFile(entry);
            }

            if (entry.getTag()) item.tag = entry.getTag();
        }

        this.writeToFile(registryContent);
    }

    writeToFile (registry) {
        let json = JSON.stringify(registry);
        let contents = new GLib.Bytes(json);

        // Make sure dir exists
        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));

        // Write contents to file asynchronously
        let file = Gio.file_new_for_path(this.REGISTRY_PATH);
        file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                            GLib.PRIORITY_DEFAULT, null, (obj, res) => {

            let stream = obj.replace_finish(res);

            stream.write_bytes_async(contents, GLib.PRIORITY_DEFAULT,
                                null, (w_obj, w_res) => {

                w_obj.write_bytes_finish(w_res);
                stream.close(null);
            });
        });
    }

    async read () {
        return new Promise(resolve => {
            if (GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) {
                let file = Gio.file_new_for_path(this.REGISTRY_PATH);
                let CACHE_FILE_SIZE = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);

                file.query_info_async('*', FileQueryInfoFlags.NONE,
                                      GLib.PRIORITY_DEFAULT, null, (src, res) => {
                    // Check if file size is larger than CACHE_FILE_SIZE
                    // If so, make a backup of file and keep only the favorites,
                    // which exist nowhere else
                    let file_info = src.query_info_finish(res);
                    const oversize = file_info.get_size() >= CACHE_FILE_SIZE * 1024 * 1024;

                    if (oversize) {
                        let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);

                        file.copy(destination, FileCopyFlags.OVERWRITE, null, null);
                    }

                    file.load_contents_async(null, (obj, res) => {
                        let [success, contents] = obj.load_contents_finish(res);

                        if (success) {
                            let max_size = this.settings.get_int(PrefsFields.HISTORY_SIZE);
                            const cacheTextData = new TextDecoder().decode(contents);
                            let registry;
                            if (cacheTextData.trim().length == 0) {
                                registry = [];
                            } else {
                                try {
                                    registry = JSON.parse(cacheTextData);
                                } catch (e) {
                                    console.error('Clipboard Indicator: cache file contains malformed JSON, starting with empty history');
                                    console.error(e);
                                    let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);
                                    file.move(destination, FileCopyFlags.OVERWRITE, null, null);
                                    resolve([]);
                                    return;
                                }
                            }
                            const entriesPromises = registry.map(
                                jsonEntry => {
                                    return ClipboardEntry.fromJSON(jsonEntry)
                                }
                            );

                            Promise.all(entriesPromises).then(clipboardEntries => {
                                clipboardEntries = clipboardEntries
                                    .filter(entry => entry !== null)
                                    .filter(entry => !oversize || entry.isFavorite());

                                let registryNoFavorite = clipboardEntries
                                    .filter(entry => !entry.isFavorite());

                                while (registryNoFavorite.length > max_size) {
                                    let oldestNoFavorite = registryNoFavorite.shift();
                                    let itemIdx = clipboardEntries.indexOf(oldestNoFavorite);
                                    clipboardEntries.splice(itemIdx,1);

                                    registryNoFavorite = clipboardEntries.filter(
                                        entry => !entry.isFavorite()
                                    );
                                }

                                resolve(clipboardEntries);
                            }).catch(e => {
                                console.error(e);
                            });
                        }
                        else {
                            console.error('Clipboard Indicator: failed to open registry file');
                        }
                    });
                });
            }
            else {
                resolve([]);
            }
        });
    }

    #entryFileExists (entry) {
        const filename = this.getEntryFilename(entry);
        return GLib.file_test(filename, FileTest.EXISTS);
    }

    async getEntryAsImage (entry) {
        if (entry.isImage() === false) return;

        if (this.#entryFileExists(entry) == false) {
            await this.writeEntryFile(entry);
        }

        const gicon = Gio.icon_new_for_string(this.getEntryFilename(entry));
        const stIcon = new St.Icon({ gicon });
        return stIcon;
    }

    async getEntryAsTexture (entry) {
        if (entry.isImage() === false) return null;

        if (this.#entryFileExists(entry) === false) {
            await this.writeEntryFile(entry);
        }

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.hash()}`;
    }

    async writeEntryFile (entry) {
        if (this.#entryFileExists(entry)) return;

        let file = Gio.file_new_for_path(this.getEntryFilename(entry));

        return new Promise(resolve => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                               GLib.PRIORITY_DEFAULT, null, (obj, res) => {

                let stream = obj.replace_finish(res);

                stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT,
                                         null, (w_obj, w_res) => {

                    w_obj.write_bytes_finish(w_res);
                    stream.close(null);
                    resolve();
                });
            });
        });
    }

    async deleteEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));

        try {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
        catch (e) {
            console.error(e);
        }
    }

    async clearCacheFolder () {
        const folder = Gio.file_new_for_path(this.REGISTRY_DIR);
        try {
            const enumerator = await folder.enumerate_children_async(
                Gio.FILE_ATTRIBUTE_STANDARD_NAME, FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT, null);
            let infos;
            while ((infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null)).length) {
                await Promise.all(infos.map(info =>
                    enumerator.get_child(info).delete_async(GLib.PRIORITY_DEFAULT, null)));
            }
        }
        catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;
    #text = null;
    #hash = null;

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        let entry;

        if (ClipboardEntry.__isText(mimetype)) {
            entry = ClipboardEntry.fromText(mimetype, jsonEntry.contents, favorite);
        }
        else {
            const filename = jsonEntry.contents;
            if (!GLib.file_test(filename, FileTest.EXISTS)) return null;

            let file = Gio.file_new_for_path(filename);

            const bytes = await new Promise((resolve, reject) => file.load_contents_async(null, (obj, res) => {
                let [success, contents] = obj.load_contents_finish(res);

                if (success) {
                    resolve(contents);
                }
                else {
                    reject(
                        new Error('Clipboard Indicator: could not read image file from cache')
                    );
                }
            }));
            entry = new ClipboardEntry(mimetype, new GLib.Bytes(bytes), favorite);
        }

        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        return entry;
    }

    static fromText (mimetype, text, favorite) {
        const entry = new ClipboardEntry(mimetype, new GLib.Bytes(new TextEncoder().encode(text)), favorite);
        entry.#text = text;
        return entry;
    }

    // bytes is the GLib.Bytes the clipboard handed over: it is kept as is and
    // handed back to St.Clipboard.set_content, never copied
    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.hash().slice(0, 12)}]`;
        }
        this.#text ??= new TextDecoder().decode(this.#bytes.toArray());
        return this.#text;
    }

    // SHA-256 of the contents, computed once: it names the image file and
    // decides equality without comparing the bytes
    hash () {
        this.#hash ??= GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, this.#bytes);
        return this.#hash;
    }

    size () {
        return this.#bytes.get_size();
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    setText (text) {
        if (!this.isText()) return;
        this.#bytes = new GLib.Bytes(new TextEncoder().encode(text));
        this.#text = text;
        this.#hash = null;
    }

    #tag = null;

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    asBytes () {
        return this.#bytes;
    }

    // Text compares as text whatever text mimetype carried it; anything else
    // must match in mimetype, length and hash, cheapest first.
    equals (otherEntry) {
        if (this.isText() || otherEntry.isText()) {
            return this.isText() && otherEntry.isText() &&
                this.getStringValue() === otherEntry.getStringValue();
        }

        return this.#mimetype === otherEntry.mimetype() &&
            this.size() === otherEntry.size() &&
            this.hash() === otherEntry.hash();
    }
}

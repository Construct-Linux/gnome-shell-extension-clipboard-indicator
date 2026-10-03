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
    #pendingEntries = null;
    #nextClearWrite = Promise.resolve();
    #writeIdleId = 0;
    #writing = false;
    #dirReady = false;

    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
        this.BOOT_ID_PATH = this.REGISTRY_DIR + '/boot-id';
        this.NEXT_HISTORY_CLEAR_PATH = this.REGISTRY_DIR + '/next-history-clear';
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

        this.#ensureDir();
        await file.replace_contents_bytes_async(new GLib.Bytes(bootId),
            null, false, Gio.FileCreateFlags.NONE, null);
    }

    // seconds since the epoch, -1 when no clear is scheduled
    async readNextHistoryClear () {
        try {
            const file = Gio.file_new_for_path(this.NEXT_HISTORY_CLEAR_PATH);
            const [contents] = await file.load_contents_async(null);
            const time = Number(new TextDecoder().decode(contents).trim());
            return Number.isInteger(time) ? time : -1;
        }
        catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(e);
            return -1;
        }
    }

    // chained, so the last value written is the last one asked for
    writeNextHistoryClear (time) {
        this.#nextClearWrite = this.#nextClearWrite.then(async () => {
            this.#ensureDir();
            await Gio.file_new_for_path(this.NEXT_HISTORY_CLEAR_PATH).replace_contents_bytes_async(
                new GLib.Bytes(`${time}`), null, false, Gio.FileCreateFlags.NONE, null);
        }).catch(e => console.error(e));
    }

    // Every change writes the whole history, several times for one copy
    // (add, evict, move to top). The file is written once the main loop is
    // idle, from the latest list, and one write never overlaps another.
    write (entries) {
        this.#pendingEntries = entries;
        this.#writeIdleId ||= GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this.#writeIdleId = 0;
            this.#flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    async #flush () {
        if (this.#writing || !this.#pendingEntries)
            return;

        const contents = new GLib.Bytes(JSON.stringify(this.#serialize(this.#pendingEntries)));
        this.#pendingEntries = null;
        this.#writing = true;
        try {
            this.#ensureDir();
            await Gio.file_new_for_path(this.REGISTRY_PATH).replace_contents_bytes_async(
                contents, null, false, Gio.FileCreateFlags.NONE, null);
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to write the registry');
            console.error(e);
        }
        finally {
            this.#writing = false;
        }

        // changes made while the file was being written
        this.#flush();
    }

    #serialize (entries) {
        return entries.map(entry => {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                item.contents = entry.hash();
            }

            if (entry.getTag()) item.tag = entry.getTag();
            return item;
        });
    }

    #ensureDir () {
        if (this.#dirReady)
            return;
        GLib.mkdir_with_parents(this.REGISTRY_DIR, 0o775);
        this.#dirReady = true;
    }

    // a pending write is started now rather than dropped; it finishes on
    // its own after the extension is disabled
    destroy () {
        if (this.#writeIdleId) {
            GLib.source_remove(this.#writeIdleId);
            this.#writeIdleId = 0;
        }
        this.#flush();
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
                            let clipboardEntries = registry
                                .map(jsonEntry => ClipboardEntry.fromJSON(jsonEntry, this.REGISTRY_DIR))
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

    async getEntryAsImage (entry) {
        if (entry.isImage() === false) return;

        const gicon = Gio.icon_new_for_string(this.getEntryFilename(entry));
        const stIcon = new St.Icon({ gicon });
        return stIcon;
    }

    async getEntryAsTexture (entry) {
        if (entry.isImage() === false) return null;

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.hash()}`;
    }

    // Images live in the cache directory, named by their hash, from the
    // moment they are copied; the entry then lets go of its bytes and
    // getEntryBytes reads them back when the image is put on the clipboard.
    async writeEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));

        this.#ensureDir();
        await file.replace_contents_bytes_async(entry.asBytes(),
            null, false, Gio.FileCreateFlags.NONE, null);
        entry.releaseBytes();
    }

    async getEntryBytes (entry) {
        if (entry.asBytes())
            return entry.asBytes();

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const [contents] = await file.load_contents_async(null);
        return new GLib.Bytes(contents);
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

    static fromJSON (jsonEntry, registryDir) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = jsonEntry.favorite;
        let entry;

        if (ClipboardEntry.__isText(mimetype)) {
            entry = ClipboardEntry.fromText(mimetype, jsonEntry.contents, favorite);
        }
        else {
            // a hash names a file in the cache directory; anything else in
            // the registry is not one of ours to open
            const hash = jsonEntry.contents;
            if (!/^[0-9a-f]{64}$/.test(hash) ||
                !GLib.file_test(`${registryDir}/${hash}`, FileTest.EXISTS))
                return null;

            entry = new ClipboardEntry(mimetype, null, favorite);
            entry.#hash = hash;
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
    // handed back to St.Clipboard.set_content, never copied. A cached image
    // has none in memory, only its hash.
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
        return this.#bytes?.get_size() ?? null;
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

    releaseBytes () {
        this.hash();
        this.#bytes = null;
    }

    // Text compares as text whatever text mimetype carried it; anything else
    // must match in mimetype, length and hash, cheapest first.
    equals (otherEntry) {
        if (this.isText() || otherEntry.isText()) {
            return this.isText() && otherEntry.isText() &&
                this.getStringValue() === otherEntry.getStringValue();
        }

        const size = this.size(), otherSize = otherEntry.size();
        return this.#mimetype === otherEntry.mimetype() &&
            (size === null || otherSize === null || size === otherSize) &&
            this.hash() === otherEntry.hash();
    }
}

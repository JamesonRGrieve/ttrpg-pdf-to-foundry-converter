// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The few parts of Foundry VTT's client API (v14) this package calls, typed
 * just enough to use them. Foundry provides them as globals at run time.
 */

interface FoundryDocument {
    id: string;
    name: string;
    toObject(): Record<string, unknown>;
    getFlag(scope: string, key: string): unknown;
}

interface FoundryDocumentClass {
    createDocuments(
        data: Record<string, unknown>[],
        options: { pack: string; keepId?: boolean },
    ): Promise<FoundryDocument[]>;
    updateDocuments(
        updates: Record<string, unknown>[],
        options: { pack: string },
    ): Promise<FoundryDocument[]>;
    deleteDocuments(ids: string[], options: { pack: string }): Promise<FoundryDocument[]>;
}

interface FoundryPack {
    collection: string;
    metadata: {
        name: string;
        label: string;
        type: string;
        packageType: string;
        flags?: Record<string, unknown>;
    };
    documentName: string;
    locked: boolean;
    folder: { id: string } | null;
    getDocuments(): Promise<FoundryDocument[]>;
    configure(configuration: Record<string, unknown>): Promise<void>;
    setFolder(folder: string | null): Promise<void>;
}

interface FoundryFolder {
    id: string;
    name: string;
    type: string;
    getFlag(scope: string, key: string): unknown;
}

interface FoundryApplicationV2 {
    element: HTMLElement;
    render(options?: boolean | Record<string, unknown>): Promise<unknown>;
    close(): Promise<unknown>;
}

interface FoundryApplicationV2Class {
    new (options?: Record<string, unknown>): FoundryApplicationV2;
}

interface DialogButton {
    action: string;
    label: string;
    default?: boolean;
    callback?: (event: Event, button: HTMLButtonElement, dialog: unknown) => unknown;
}

declare const game: {
    user: { isGM: boolean };
    system: { id: string };
    world: { id: string };
    packs: { get(collection: string): FoundryPack | undefined };
    folders: { contents: FoundryFolder[] };
    modules: { get(id: string): { version?: string } | undefined };
};

declare const Hooks: {
    once(hook: string, fn: (...args: unknown[]) => void): void;
    on(hook: string, fn: (...args: unknown[]) => void): void;
};

declare const ui: {
    notifications: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
};

declare const CONFIG: Record<string, { documentClass: FoundryDocumentClass } | undefined>;

declare const foundry: {
    applications: {
        api: {
            ApplicationV2: FoundryApplicationV2Class;
            DialogV2: {
                wait(config: {
                    window: { title: string };
                    content: string;
                    buttons: DialogButton[];
                    rejectClose?: boolean;
                    position?: { width?: number };
                }): Promise<unknown>;
            };
        };
        apps: {
            FilePicker: {
                implementation: {
                    upload(
                        source: string,
                        path: string,
                        file: File,
                        body?: Record<string, unknown>,
                        options?: { notify?: boolean },
                    ): Promise<unknown>;
                    createDirectory(source: string, target: string): Promise<unknown>;
                    browse(source: string, target: string): Promise<{ files: string[]; dirs: string[] }>;
                };
            };
        };
    };
    documents: {
        collections: {
            CompendiumCollection: {
                createCompendium(metadata: Record<string, unknown>): Promise<FoundryPack>;
            };
        };
        Folder: {
            create(data: Record<string, unknown>): Promise<FoundryFolder>;
        };
    };
};

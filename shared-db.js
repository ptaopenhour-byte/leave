(function () {
    const STORAGE_PREFIX = "ibsh_";
    const COLLECTIONS = {
        students: { idField: "studentId" },
        late: { idField: "id" },
        leave: { idField: "id" },
    };

    const state = {
        initPromise: null,
        initialized: false,
        mode: "local",
        firebaseReady: false,
        authReady: false,
        userId: "",
        firestore: null,
        error: "",
        cache: {},
        remoteIds: {
            students: new Set(),
            late: new Set(),
            leave: new Set(),
        },
    };

    function deepCopy(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function localKey(key) {
        return STORAGE_PREFIX + key;
    }

    function loadLocal(key) {
        try {
            return JSON.parse(localStorage.getItem(localKey(key)) || "[]");
        } catch (error) {
            console.warn("[AppDB] Failed to load local data for", key, error);
            return [];
        }
    }

    function saveLocal(key, value) {
        localStorage.setItem(localKey(key), JSON.stringify(value));
    }

    function getDocId(key, record) {
        const field = COLLECTIONS[key].idField;
        return String(record?.[field] || "").trim();
    }

    function normalizeRecord(key, record) {
        if (!record || typeof record !== "object") return null;
        const normalized = { ...record };
        const docId = getDocId(key, normalized);
        if (!docId) return null;
        normalized[COLLECTIONS[key].idField] = docId;
        return normalized;
    }

    function normalizeCollection(key, records) {
        const list = Array.isArray(records) ? records : [];
        return list
            .map(record => normalizeRecord(key, record))
            .filter(Boolean);
    }

    function currentStatus() {
        return {
            mode: state.mode,
            firebaseReady: state.firebaseReady,
            authReady: state.authReady,
            initialized: state.initialized,
            userId: state.userId,
            error: state.error,
        };
    }

    function notifyStatus() {
        window.dispatchEvent(new CustomEvent("app-db-status", { detail: currentStatus() }));
    }

    function hasFirebaseConfig() {
        const config = window.FIREBASE_CONFIG || {};
        return Boolean(config.apiKey && config.projectId && config.appId);
    }

    async function ensureAuthenticated() {
        if (typeof window.firebase?.auth !== "function") {
            throw new Error("Firebase Auth SDK is not loaded.");
        }

        const auth = window.firebase.auth();
        if (auth.currentUser) {
            state.authReady = true;
            state.userId = auth.currentUser.uid || "";
            return auth.currentUser;
        }

        const result = await auth.signInAnonymously();
        const user = result?.user || auth.currentUser;
        if (!user) {
            throw new Error("Anonymous sign-in succeeded but no user was returned.");
        }

        state.authReady = true;
        state.userId = user.uid || "";
        return user;
    }

    async function initFirebase() {
        if (!hasFirebaseConfig() || !window.firebase) {
            state.mode = "local";
            state.firebaseReady = false;
            state.authReady = false;
            state.userId = "";
            notifyStatus();
            return;
        }

        const config = window.FIREBASE_CONFIG;
        if (!window.firebase.apps.length) {
            window.firebase.initializeApp(config);
        }

        await ensureAuthenticated();
        state.firestore = window.firebase.firestore();

        const options = window.FIREBASE_OPTIONS || {};
        if (options.useEmulator) {
            state.firestore.useEmulator(options.emulatorHost || "127.0.0.1", options.emulatorPort || 8080);
        }

        const keys = Object.keys(COLLECTIONS);
        const results = await Promise.all(keys.map(async (key) => {
            const snapshot = await state.firestore.collection(key).get();
            const items = [];
            const ids = new Set();
            snapshot.forEach(doc => {
                const data = doc.data() || {};
                const normalized = normalizeRecord(key, {
                    ...data,
                    [COLLECTIONS[key].idField]: data[COLLECTIONS[key].idField] || doc.id,
                });
                if (!normalized) return;
                items.push(normalized);
                ids.add(getDocId(key, normalized));
            });
            return { key, items, ids };
        }));

        results.forEach(({ key, items, ids }) => {
            state.cache[key] = items;
            state.remoteIds[key] = ids;
            saveLocal(key, items);
        });

        state.mode = "firebase";
        state.firebaseReady = true;
        state.error = "";
        notifyStatus();
    }

    async function init() {
        if (state.initPromise) return state.initPromise;

        Object.keys(COLLECTIONS).forEach(key => {
            state.cache[key] = loadLocal(key);
            state.remoteIds[key] = new Set(state.cache[key].map(item => getDocId(key, item)));
        });
        notifyStatus();

        state.initPromise = (async () => {
            try {
                await initFirebase();
            } catch (error) {
                console.warn("[AppDB] Firebase init failed; falling back to localStorage.", error);
                state.mode = "local";
                state.firebaseReady = false;
                state.authReady = false;
                state.userId = "";
                state.error = error?.message || String(error);
                notifyStatus();
            } finally {
                state.initialized = true;
                notifyStatus();
            }
        })();

        return state.initPromise;
    }

    async function commitOperations(operations) {
        if (!operations.length || !state.firestore) return;

        for (let index = 0; index < operations.length; index += 400) {
            const batch = state.firestore.batch();
            operations.slice(index, index + 400).forEach(run => run(batch));
            await batch.commit();
        }
    }

    function persistRemote(key, records) {
        if (state.mode !== "firebase" || !state.firestore) return Promise.resolve();

        const nextIds = new Set(records.map(record => getDocId(key, record)));
        const previousIds = new Set(state.remoteIds[key] || []);
        const collection = state.firestore.collection(key);
        const operations = [];

        previousIds.forEach(id => {
            if (!nextIds.has(id)) {
                operations.push(batch => batch.delete(collection.doc(id)));
            }
        });

        records.forEach(record => {
            const id = getDocId(key, record);
            operations.push(batch => batch.set(collection.doc(id), record, { merge: false }));
        });

        return commitOperations(operations)
            .then(() => {
                state.remoteIds[key] = nextIds;
                state.error = "";
                notifyStatus();
            })
            .catch((error) => {
                state.error = error?.message || String(error);
                notifyStatus();
                console.error("[AppDB] Remote sync failed for", key, error);
            });
    }

    function set(key, value) {
        const records = normalizeCollection(key, value);
        state.cache[key] = records;
        saveLocal(key, records);
        notifyStatus();
        return persistRemote(key, records);
    }

    function get(key) {
        return deepCopy(state.cache[key] || []);
    }

    window.AppDB = {
        init,
        get,
        set,
        status: currentStatus,
        hasFirebaseConfig,
        students() { return get("students"); },
        late() { return get("late"); },
        leave() { return get("leave"); },
    };
})();

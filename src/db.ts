import type { SmtpSettings } from "./types";

const DB_NAME = "OmniToolsExpenseDb";
const DB_VERSION = 4;
const STORE_SETTINGS = "settings";

interface SettingsRow {
  key: string;
  value: SmtpSettings;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 4) {
        if (db.objectStoreNames.contains("reimbursements")) {
          db.deleteObjectStore("reimbursements");
        }
        if (db.objectStoreNames.contains("expenseLines")) {
          db.deleteObjectStore("expenseLines");
        }
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SETTINGS, "readonly");
  const store = tx.objectStore(STORE_SETTINGS);
  const row = await promisifyRequest<SettingsRow | undefined>(store.get("smtp"));
  await transactionComplete(tx);
  db.close();
  return row?.value ?? null;
}

export async function saveSmtpSettings(settings: SmtpSettings): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_SETTINGS, "readwrite");
  const row: SettingsRow = { key: "smtp", value: settings };
  tx.objectStore(STORE_SETTINGS).put(row);
  await transactionComplete(tx);
  db.close();
}

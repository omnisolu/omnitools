import type { ExpenseLine, HeaderInfo } from "./types";

const DB_NAME = "OmniToolsExpenseDb";
const DB_VERSION = 1;
const STORE_REIMBURSEMENTS = "reimbursements";
const STORE_EXPENSE_LINES = "expenseLines";

export interface ReimbursementRecord {
  id: string;
  createdAt: string;
  header: HeaderInfo;
  cashAdvance: number;
  managerName: string;
  businessPurpose: string;
}

export interface ExpenseLineRecord {
  id: string;
  reimbursementId: string;
  date: string;
  description: string;
  category: string;
  lineCurrency: string;
  exchangeRate: number;
  gst: number;
  grossAmount: number;
  fileName: string;
  fileType: string;
  fileBlob: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_REIMBURSEMENTS)) {
        db.createObjectStore(STORE_REIMBURSEMENTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_EXPENSE_LINES)) {
        const store = db.createObjectStore(STORE_EXPENSE_LINES, { keyPath: "id" });
        store.createIndex("reimbursementId", "reimbursementId", { unique: false });
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

export async function saveReimbursement(options: {
  id: string;
  header: HeaderInfo;
  cashAdvance: number;
  managerName: string;
  businessPurpose: string;
  expenses: ExpenseLine[];
}): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([STORE_REIMBURSEMENTS, STORE_EXPENSE_LINES], "readwrite");
  const reimbursements = tx.objectStore(STORE_REIMBURSEMENTS);
  const expenseLines = tx.objectStore(STORE_EXPENSE_LINES);

  const record: ReimbursementRecord = {
    id: options.id,
    createdAt: new Date().toISOString(),
    header: options.header,
    cashAdvance: options.cashAdvance,
    managerName: options.managerName,
    businessPurpose: options.businessPurpose,
  };

  reimbursements.put(record);

  for (const expense of options.expenses) {
    const expenseRecord: ExpenseLineRecord = {
      id: expense.id,
      reimbursementId: options.id,
      date: expense.date,
      description: expense.description,
      category: expense.category,
      lineCurrency: expense.lineCurrency,
      exchangeRate: expense.exchangeRate,
      gst: expense.gst,
      grossAmount: expense.grossAmount,
      fileName: expense.file.name,
      fileType: expense.file.type,
      fileBlob: new Blob([expense.file], { type: expense.file.type }),
    };
    expenseLines.put(expenseRecord);
  }

  await transactionComplete(tx);
  db.close();
}

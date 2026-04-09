import type { HeaderInfo } from "./types";

/** 服务端 SQLite 中的报销主表（与后台列表一致） */
export interface ReimbursementRecord {
  id: string;
  createdAt: string;
  header: HeaderInfo;
  cashAdvance: number;
  managerName: string;
  businessPurpose: string;
  /** 付款方式（与确认页一致） */
  paymentMethod: string;
}

/** 附件元数据（服务端仅存文件名；浏览器本地库已废弃报销后不再使用 Blob） */
export interface ExpenseLineAttachmentRecord {
  fileName: string;
  fileType: string;
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
  attachments: ExpenseLineAttachmentRecord[];
}

export interface HeaderInfo {
  employeeName: string;
  department: string;
  /** 公司：可选预设 Omnisolu / Metablox，或任意自定义名称 */
  companyName: string;
  /** 本次报销结算基准币种（如 CAD、USD） */
  baseCurrency: string;
  periodFrom: string;
  periodTo: string;
}

export interface ExpenseLine {
  id: string;
  date: string;
  description: string;
  category: string;
  /** 本行费用币种 */
  lineCurrency: string;
  /**
   * 折算基准币种：基准金额 = 本行金额 × exchangeRate
   * （表示 1 单位本行币种对应多少基准币种）
   */
  exchangeRate: number;
  gst: number;
  grossAmount: number;
  file: File;
}

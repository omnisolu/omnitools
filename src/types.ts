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

/** SMTP 配置（由服务端写入 data/omnitools.sqlite，见 emailApi） */
export interface SmtpSettings {
  host: string;
  port: number;
  /** 465 通常为 true；587 多为 false（STARTTLS） */
  secure: boolean;
  user: string;
  pass: string;
  /** 发件人邮箱（显示为 From） */
  fromEmail: string;
  /** 默认收件人，可留空，发送时再填 */
  defaultToEmail: string;
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
  /** 该行关联的收据附件（至少一张） */
  files: File[];
}

import { useCallback, useEffect, useState } from "react";
import type { ProfilePresetRow } from "./emailApi";
import {
  createProfileCompany,
  createProfileExpenseCategory,
  createProfileProject,
  fetchProfileCompanies,
  fetchProfileExpenseCategories,
  fetchProfileProjects,
  patchProfileCompany,
  patchProfileExpenseCategory,
  patchProfileProject,
} from "./emailApi";

interface ProfileSettingsProps {
  onFormPresetsChanged?: () => void;
  /** 从「通知 / SMTP」卡片跳转到管理后台的 SMTP 标签 */
  onOpenSmtpTab?: () => void;
}

type PresetKind = "company" | "category" | "project";

type HubSection = "hub" | PresetKind | "notifications";

function PresetCard(props: {
  title: string;
  hint: string;
  kind: PresetKind;
  onFormPresetsChanged?: () => void;
  onBack: () => void;
}) {
  const { title, hint, kind, onFormPresetsChanged, onBack } = props;

  const [items, setItems] = useState<ProfilePresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [addName, setAddName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list =
        kind === "company"
          ? await fetchProfileCompanies()
          : kind === "category"
            ? await fetchProfileExpenseCategories()
            : await fetchProfileProjects();
      setItems(list);
    } catch (e) {
      setError((e as Error)?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(row: ProfilePresetRow) {
    const name = draft.trim();
    if (!name) {
      setError("名称不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list =
        kind === "company"
          ? await patchProfileCompany(row.id, { name })
          : kind === "category"
            ? await patchProfileExpenseCategory(row.id, { name })
            : await patchProfileProject(row.id, { name });
      setItems(list);
      setEditingId(null);
      onFormPresetsChanged?.();
    } catch (e) {
      setError((e as Error)?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(row: ProfilePresetRow) {
    setBusy(true);
    setError(null);
    try {
      const list =
        kind === "company"
          ? await patchProfileCompany(row.id, { active: !row.active })
          : kind === "category"
            ? await patchProfileExpenseCategory(row.id, { active: !row.active })
            : await patchProfileProject(row.id, { active: !row.active });
      setItems(list);
      if (editingId === row.id) setEditingId(null);
      onFormPresetsChanged?.();
    } catch (e) {
      setError((e as Error)?.message || "更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const n = addName.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const list =
        kind === "company"
          ? await createProfileCompany(n)
          : kind === "category"
            ? await createProfileExpenseCategory(n)
            : await createProfileProject(n);
      setItems(list);
      setAddName("");
      onFormPresetsChanged?.();
    } catch (e) {
      setError((e as Error)?.message || "添加失败");
    } finally {
      setBusy(false);
    }
  }

  const addPlaceholder =
    kind === "company" ? "新公司名" : kind === "category" ? "新类别名" : "新项目名";

  return (
    <div className="profile-settings-detail">
      <button type="button" className="btn btn--ghost profile-settings-back" onClick={onBack}>
        ← 返回概览
      </button>
      <section className="card profile-preset-card">
        <h3 className="profile-preset-card-title">{title}</h3>
        <p className="card-hint profile-preset-hint">{hint}</p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="admin-empty">正在加载…</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="admin-table profile-preset-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>状态</th>
                    <th className="profile-preset-actions-col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {editingId === row.id ? (
                          <input
                            className="field-input"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            disabled={busy}
                            aria-label="编辑名称"
                          />
                        ) : (
                          <span>{row.name}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={
                            row.active
                              ? "profile-preset-badge profile-preset-badge--on"
                              : "profile-preset-badge profile-preset-badge--off"
                          }
                        >
                          {row.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="profile-preset-actions">
                        {editingId === row.id ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={busy}
                              onClick={() => void handleSave(row)}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => {
                                setEditingId(null);
                                setDraft("");
                              }}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => {
                                setEditingId(row.id);
                                setDraft(row.name);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={busy}
                              onClick={() => void handleToggleActive(row)}
                            >
                              {row.active ? "停用" : "启用"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="profile-preset-add">
              <input
                className="field-input"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={addPlaceholder}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd();
                }}
              />
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={busy || !addName.trim()}
                onClick={() => void handleAdd()}
              >
                Add
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const HUB_CARDS: Array<{
  id: HubSection;
  title: string;
  description: string;
}> = [
  {
    id: "company",
    title: "公司",
    description: "维护公司名称列表；启用项出现在报销单与订阅表单的公司下拉中。",
  },
  {
    id: "category",
    title: "费用类别",
    description: "Expense Category 预设；启用项出现在报销明细类别下拉中。",
  },
  {
    id: "project",
    title: "项目",
    description: "订阅追踪中的项目选项；与 Profile 中维护的列表为同一数据源。",
  },
  {
    id: "notifications",
    title: "通知（SMTP）",
    description: "配置发信邮箱与 SMTP，用于报销 PDF、订阅提醒等邮件。",
  },
];

export default function ProfileSettings({
  onFormPresetsChanged,
  onOpenSmtpTab,
}: ProfileSettingsProps) {
  const [section, setSection] = useState<HubSection>("hub");

  if (section === "company") {
    return (
      <PresetCard
        title="公司列表"
        hint="停用后下拉中不再显示，仍可手动输入任意公司名。"
        kind="company"
        onFormPresetsChanged={onFormPresetsChanged}
        onBack={() => setSection("hub")}
      />
    );
  }
  if (section === "category") {
    return (
      <PresetCard
        title="费用类别"
        hint="停用后仅在下拉中隐藏。"
        kind="category"
        onFormPresetsChanged={onFormPresetsChanged}
        onBack={() => setSection("hub")}
      />
    );
  }
  if (section === "project") {
    return (
      <PresetCard
        title="项目（订阅）"
        hint="启用项会出现在订阅表单的项目建议列表中。"
        kind="project"
        onFormPresetsChanged={onFormPresetsChanged}
        onBack={() => setSection("hub")}
      />
    );
  }
  if (section === "notifications") {
    return (
      <div className="profile-settings-detail">
        <button type="button" className="btn btn--ghost profile-settings-back" onClick={() => setSection("hub")}>
          ← 返回概览
        </button>
        <section className="card profile-settings-smtp-hint">
          <h3 className="profile-preset-card-title">SMTP 与邮件通知</h3>
          <p className="card-hint profile-preset-hint">
            点击下方按钮将切换到左侧菜单中的「SMTP 设置」，在同一后台完成主机、端口、发件人及密码等配置。
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onOpenSmtpTab?.()}
            disabled={!onOpenSmtpTab}
          >
            打开 SMTP 设置
          </button>
          {!onOpenSmtpTab ? (
            <p className="card-hint profile-preset-hint">当前环境未接入后台标签切换，请从侧栏进入「SMTP 设置」。</p>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="profile-settings-hub">
      <header className="profile-settings-hub-header">
        <h2 className="profile-settings-hub-title">Profile Setting</h2>
        <p className="profile-settings-hub-sub">
          管理公司、费用类别、订阅项目等预设；启用项与报销单、订阅表单下拉共用同一份服务端数据。
        </p>
      </header>
      <div className="profile-settings-card-grid">
        {HUB_CARDS.map((c) => (
          <button
            key={c.id}
            type="button"
            className="profile-settings-tile"
            onClick={() => setSection(c.id)}
          >
            <h3 className="profile-settings-tile-title">{c.title}</h3>
            <p className="profile-settings-tile-desc">{c.description}</p>
            <span className="profile-settings-tile-link">Open →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import type { ProfilePresetRow } from "./emailApi";
import {
  createProfileCompany,
  createProfileExpenseCategory,
  fetchProfileCompanies,
  fetchProfileExpenseCategories,
  patchProfileCompany,
  patchProfileExpenseCategory,
} from "./emailApi";

interface ProfileSettingsProps {
  onFormPresetsChanged?: () => void;
}

type PresetKind = "company" | "category";

function PresetCard(props: {
  title: string;
  hint: string;
  kind: PresetKind;
  onFormPresetsChanged?: () => void;
}) {
  const { title, hint, kind, onFormPresetsChanged } = props;

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
          : await fetchProfileExpenseCategories();
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
          : await patchProfileExpenseCategory(row.id, { name });
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
          : await patchProfileExpenseCategory(row.id, { active: !row.active });
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
          : await createProfileExpenseCategory(n);
      setItems(list);
      setAddName("");
      onFormPresetsChanged?.();
    } catch (e) {
      setError((e as Error)?.message || "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
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
              placeholder={kind === "company" ? "新公司名" : "新类别名"}
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
  );
}

export default function ProfileSettings({ onFormPresetsChanged }: ProfileSettingsProps) {
  return (
    <div className="admin-profile-grid">
      <PresetCard
        title="Company List"
        hint="公司快捷选项；停用后下拉中不再显示，仍可手动输入任意公司名。"
        kind="company"
        onFormPresetsChanged={onFormPresetsChanged}
      />
      <PresetCard
        title="费用类别"
        hint="Expense Category；停用后仅在下拉中隐藏。"
        kind="category"
        onFormPresetsChanged={onFormPresetsChanged}
      />
    </div>
  );
}

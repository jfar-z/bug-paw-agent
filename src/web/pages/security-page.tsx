import { Button, TextField, Textarea } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { ShieldCheck, KeyRound, Copy, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SecurityStatus, TotpSetup } from "../../shared/security-contracts";
import { api, type ApiClientError } from "../api";
import { useApiTask } from "../api-task-provider";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { NAVIGATION_BEFORE_EVENT, type NavigationBeforeEvent } from "../router";
import "../configuration.css";
import "../security.css";

/** 管理短期绑定和恢复码；敏感内容仅存在当前页面内存，绝不缓存。 */
export function SecurityPage() {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const online = useOnlineStatus();
  const controller = useRef({ runApiTask, toast });
  controller.current = { runApiTask, toast };
  const [status, setStatus] = useState<SecurityStatus>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [setup, setSetup] = useState<TotpSetup>();
  const [codes, setCodes] = useState<string[]>();
  const [savedCodes, setSavedCodes] = useState(false);
  const [proof, setProof] = useState<"setup" | "disable" | "recovery">();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [leave, setLeave] = useState<() => void>();
  const guard = useRef({ busy, sensitive: Boolean(setup || (codes && !savedCodes) || password) });
  guard.current = { busy, sensitive: Boolean(setup || (codes && !savedCodes) || password) };
  const bypass = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    if (!online) { setLoading(false); return; }
    void controller.current.runApiTask(api.getSecurityStatus, { operation: "读取双因素认证状态" }).then((result) => {
      if (!active) return;
      if (result.status === "success") { setStatus(result.data); setUncertain(false); }
      else setStatus(undefined);
      setLoading(false);
    });
    return () => { active = false; };
  }, [reload, online]);

  useEffect(() => {
    if (!setup) return;
    const timer = window.setTimeout(() => { setSetup(undefined); setCode(""); setMessage("绑定信息已过期，请重新开始绑定或刷新认证状态。"); }, Math.max(0, Date.parse(setup.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [setup]);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (bypass.current || (!guard.current.busy && !guard.current.sensitive)) return;
      event.preventDefault();
      if (!guard.current.busy) setLeave(() => (event as NavigationBeforeEvent).resume);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!guard.current.busy && !guard.current.sensitive) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener(NAVIGATION_BEFORE_EVENT, navigate);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener(NAVIGATION_BEFORE_EVENT, navigate); window.removeEventListener("beforeunload", unload); };
  }, []);

  function closeProof() { setProof(undefined); setPassword(""); setCode(""); setRecovery(false); }
  function openProof(action: "setup" | "disable" | "recovery") { setMessage(""); setPassword(""); setCode(""); setRecovery(false); setProof(action); }
  function refreshStatus() { setSetup(undefined); setCode(""); setReload((value) => value + 1); }

  /** 预期错误保留当前表单，并继续通过统一错误通知提供诊断信息。 */
  function expectedError(error: ApiClientError) {
    setMessage(error.message);
    controller.current.toast.push(toUnexpectedErrorNotice(error, "管理双因素认证"));
    if (error.code === "TOTP_INVALID_CODE") setCode("");
    if (error.code === "TOTP_CHALLENGE_EXPIRED") { setSetup(undefined); setCode(""); }
    if (error.code === "TOTP_STATE_CONFLICT") { setUncertain(true); setSetup(undefined); closeProof(); }
  }

  async function task<T>(operation: string, execute: () => Promise<T>, success: (data: T) => void, mutation = true) {
    if (!online || lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const result = await controller.current.runApiTask(execute, { operation, expected: {
        INVALID_CREDENTIALS: expectedError, TOTP_INVALID_CODE: expectedError, TOTP_RATE_LIMITED: expectedError,
        TOTP_CHALLENGE_EXPIRED: expectedError, TOTP_STATE_CONFLICT: expectedError,
      } });
      if (result.status === "success") success(result.data);
      else if (result.status === "unexpected" && mutation) {
        // 网络断开可能发生在服务端提交之后，不能把未知结果断言为未启用。
        setUncertain(true);
        setSetup(undefined);
        setMessage("认证操作结果尚未确认，请查看错误通知并刷新状态。若已启用，可使用验证器登录后重新生成恢复码。");
        closeProof();
      }
    } finally { lock.current = false; setBusy(false); }
  }

  async function submitProof(event: React.FormEvent) {
    event.preventDefault();
    if (!proof) return;
    if (proof === "setup") {
      await task("创建双因素绑定", () => api.beginTotpSetup(password), (data) => { closeProof(); setSetup(data); });
    } else {
      const action = proof;
      await task(action === "disable" ? "关闭双因素认证" : "重新生成恢复码", () => api.manageTotp(action, { password, code, recovery }), (data) => {
        closeProof(); setSavedCodes(false);
        if (action === "disable") { setStatus({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 }); setCodes(undefined); setMessage("双因素认证已关闭，其他设备需重新登录。"); }
        else { setCodes(data.recoveryCodes); setStatus((current) => current && { ...current, recoveryCodesRemaining: data.recoveryCodes.length }); }
      });
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    await task("验证并启用双因素认证", () => api.confirmTotpSetup(code), (data) => {
      setSetup(undefined); setCode(""); setCodes(data.recoveryCodes); setSavedCodes(false);
      setStatus({ enabled: true, enabledAt: null, recoveryCodesRemaining: data.recoveryCodes.length });
      setMessage("双因素认证已启用，其他设备需重新登录。请保存恢复码。");
      title.current?.focus();
    });
  }

  /** 剪贴板不可用时选择文本并提示手动复制，不能冒充复制成功。 */
  async function copy(value: string, elementId: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value); setMessage("已复制，请妥善保管。");
    } catch {
      const element = document.getElementById(elementId);
      if (element instanceof HTMLTextAreaElement) { element.focus(); element.select(); }
      else if (element) {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setMessage("浏览器未允许自动复制，已选中内容，请长按或按 Ctrl/Cmd+C 手动复制。");
    }
  }

  function downloadCodes() {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob(["BugPaw 一次性恢复码，请安全保存。每个码只能使用一次。\n\n" + codes.join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "bugpaw-recovery-codes.txt"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function discardAndLeave() {
    const resume = leave;
    if (!resume) return;
    if (setup && online) {
      let cancelled = false;
      await task("离开前取消双因素绑定", api.cancelTotpSetup, () => { cancelled = true; }, false);
      if (!cancelled) return;
    }
    setSetup(undefined); setCodes(undefined); closeProof(); setLeave(undefined);
    bypass.current = true; resume(); window.queueMicrotask(() => { bypass.current = false; });
  }

  const blocked = busy || !online || uncertain;
  return <main className="configuration-page security-page">
    <header className="configuration-page__heading"><span className="configuration-eyebrow">SECURITY</span><h1 ref={title} tabIndex={-1}>安全设置</h1><p>为你的 BugPaw 工作区增加一层登录保护。</p></header>
    {!online ? <p className="security-notice" role="status">当前处于离线状态。连接服务后才能绑定、验证或管理双因素认证。</p> : null}
    {message ? <p className="security-notice" role="status">{message}</p> : null}
    {loading ? <p role="status">正在读取安全设置…</p> : null}
    {!status && !loading ? <section className="security-card"><p>安全状态尚未读取，不能据此判断是否启用双因素认证。</p><Button className="configuration-secondary-action" disabled={!online || busy} onClick={refreshStatus}>重新加载</Button></section> : null}
    {uncertain ? <Button className="configuration-secondary-action" disabled={!online || busy} onClick={refreshStatus}>刷新认证状态</Button> : null}
    {status && !loading && !uncertain ? <section className="security-card" aria-busy={busy}>
      <div className="security-row security-card-heading"><h2>{setup ? "绑定验证器" : codes ? "保存恢复码" : "双因素认证"}</h2><span className={`security-badge${status.enabled ? " is-enabled" : ""}`}>{status.enabled ? "已启用" : setup ? "待验证 · 尚未启用" : "未启用"}</span></div>
      {setup ? <>
        <ol className="security-steps" aria-label="绑定进度"><li>1 确认身份</li><li aria-current="step">2 绑定验证器</li><li>3 保存恢复码</li></ol>
        <div className="security-binding"><div className="security-qr"><img src={setup.qrCode} alt="用于绑定 BugPaw 验证器的二维码" width={240} height={240} /><small>使用验证器扫描二维码</small></div><div><h3>扫码添加 BugPaw</h3><p>打开验证器，选择添加账户并扫描二维码。</p><label className="security-field" htmlFor="totp-secret">无法扫码？手动输入密钥<Textarea id="totp-secret" value={setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret} readOnly rows={2} spellCheck={false} /></label><Button type="button" className="configuration-secondary-action" onClick={() => void copy(setup.secret, "totp-secret")}><Copy size={16} aria-hidden="true" />复制密钥</Button><p className="security-help">密钥仅在绑定期间展示，请勿分享。<br />基于时间 · 6 位 · 每 30 秒更新 · SHA-1</p></div></div>
        <form onSubmit={(event) => void confirm(event)} className="security-verification"><h3>输入首次验证码</h3><p>验证通过并保存后，双因素认证立即生效。</p><OtpInput value={code} onChange={setCode} disabled={blocked} /><div className="security-savebar"><small>启用后，其他设备需重新登录；当前设备保持登录。</small><div className="security-actions"><Button type="button" className="configuration-secondary-action" disabled={busy || !online} onClick={() => void task("取消双因素绑定", api.cancelTotpSetup, () => { setSetup(undefined); setCode(""); setMessage("已取消绑定，双因素认证未启用。"); }, false)}>取消绑定</Button><Button variant="primary" className="configuration-primary-action" disabled={blocked} type="submit">{busy ? "正在验证…" : "验证并启用"}</Button></div></div></form>
      </> : codes ? <>
        <h3>为无法使用验证器的情况留一份备用</h3><p>每个恢复码只能使用一次。请保存到密码管理器或其他安全的位置，之后无法再次查看这批恢复码。</p>
        <div className="security-codes" id="totp-recovery-codes">{codes.map((item) => <code key={item}>{item}</code>)}</div>
        <div className="security-actions"><Button className="configuration-secondary-action" onClick={() => void copy(codes.join("\n"), "totp-recovery-codes")}><Copy size={16} aria-hidden="true" />复制恢复码</Button><Button className="configuration-secondary-action" onClick={downloadCodes}><Download size={16} aria-hidden="true" />下载恢复码</Button></div>
        <label className="security-check"><Checkbox checked={savedCodes} onChange={(event) => setSavedCodes(event.target.checked)} />我已将恢复码保存到安全的位置</label>
        <div className="security-savebar"><small>双因素认证已生效，离开本页不会关闭。</small><Button variant="primary" className="configuration-primary-action" disabled={!savedCodes} onClick={() => { setCodes(undefined); setMessage(""); title.current?.focus(); }}>完成设置</Button></div>
      </> : status.enabled ? <>
        <div className="security-management"><div><h3>验证器已绑定</h3><p>新登录需验证访问密码和动态验证码。绑定密钥不再显示。</p></div><ShieldCheck size={24} aria-hidden="true" /></div>
        <div className="security-management"><div><h3>恢复码</h3><p>还剩 {status.recoveryCodesRemaining} 个可用恢复码。重新生成将使旧恢复码立即失效，并要求其他设备重新登录。</p></div><Button className="configuration-secondary-action" disabled={blocked} onClick={() => openProof("recovery")}>重新生成恢复码</Button></div>
        <div className="security-management"><div><h3>关闭双因素认证</h3><p>关闭后，仅需访问密码即可登录。</p></div><Button variant="danger" className="configuration-secondary-action configuration-secondary-action--danger" disabled={blocked} onClick={() => openProof("disable")}>关闭双因素认证</Button></div>
      </> : <>
        <p>在访问密码之外，再使用验证器生成的动态验证码。即使密码泄露，他人也无法仅凭密码登录。</p>
        <div className="security-benefit"><ShieldCheck size={20} aria-hidden="true" /><div><h3>使用你熟悉的验证器</h3><p>支持 Google Authenticator、Microsoft Authenticator、1Password 等兼容 TOTP 的应用。</p></div></div>
        <div className="security-benefit"><KeyRound size={20} aria-hidden="true" /><div><h3>验证成功后才会启用</h3><p>扫码或手动录入密钥，完成首次 6 位验证码验证。</p></div></div>
        <Button variant="primary" className="configuration-primary-action" data-security-start disabled={blocked} onClick={() => openProof("setup")}>开启双因素认证</Button>
      </>}
    </section> : null}
    <p className="security-help">双因素认证用于工作台登录。验证码按时间更新，请保持服务器与验证器设备时间准确。</p>
    {proof ? <ConfigurationEditorDialog variant="confirmation" title={proof === "setup" ? "确认你的身份" : proof === "disable" ? "关闭双因素认证" : "重新生成恢复码"} description={proof === "setup" ? "输入访问密码，开始绑定验证器。" : proof === "disable" ? "关闭后仅使用访问密码登录，其他设备将退出登录。" : "验证身份后生成新恢复码，旧恢复码立即失效，其他设备将退出登录。"} busy={busy} suspended={Boolean(leave)} onClose={closeProof} returnFocusSelector="[data-security-start]" footer={<><Button className="configuration-secondary-action" disabled={busy} onClick={closeProof}>取消</Button><Button variant="primary" className="configuration-primary-action" form="security-proof-form" type="submit" disabled={blocked}>{busy ? "正在验证…" : proof === "setup" ? "继续绑定" : proof === "disable" ? "验证并关闭" : "验证并重新生成"}</Button></>}>
      <form id="security-proof-form" onSubmit={(event) => void submitProof(event)}><label className="security-field">访问密码<TextField type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={1024} disabled={busy} required /></label>{proof !== "setup" ? <><OtpInput value={code} onChange={setCode} disabled={busy} recovery={recovery} /><Button className="configuration-secondary-action" type="button" disabled={busy} onClick={() => { setRecovery(!recovery); setCode(""); }}>{recovery ? "使用验证器验证码" : "无法使用验证器？使用恢复码"}</Button></> : null}</form>
      {message ? <p className="configuration-inline-error" role="alert">{message}</p> : null}
    </ConfigurationEditorDialog> : null}
    {leave ? <ConfigurationEditorDialog variant="confirmation" title={codes ? "恢复码尚未保存" : "离开安全设置？"} description={codes ? "双因素认证已经启用。离开后无法再次查看这批恢复码，之后需要重新验证身份才能生成新恢复码。" : "离开将丢弃当前输入。未验证的绑定不会启用双因素认证；离线时绑定草稿会自动过期。"} busy={busy} onClose={() => setLeave(undefined)} footer={<><Button className="configuration-secondary-action" onClick={() => setLeave(undefined)} disabled={busy}>继续设置</Button><Button variant="danger" className="configuration-secondary-action configuration-secondary-action--danger" onClick={() => void discardAndLeave()} disabled={busy}>确认离开</Button></>}><span /></ConfigurationEditorDialog> : null}
  </main>;
}

/** 单输入框保留验证码前导零，并支持粘贴与系统自动填充。 */
function OtpInput({ value, onChange, disabled, recovery = false }: { value: string; onChange: (value: string) => void; disabled: boolean; recovery?: boolean }) {
  return <label className="security-field security-code-field">{recovery ? "一次性恢复码" : "6 位验证码"}<TextField value={value} onChange={(event) => onChange(event.target.value)} type="text" inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" pattern={recovery ? undefined : "[0-9]{6}"} maxLength={recovery ? 64 : 6} className={recovery ? "" : "security-otp"} disabled={disabled} required /><small>{recovery ? "输入一个尚未使用的恢复码。" : "输入验证器中显示的 6 位数字，保留开头的 0。"}</small></label>;
}

import { ArrowRight, BookOpen, HardDrive, LockKeyhole, Wifi, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LoginResponse } from "../../shared/security-contracts";
import { useOnlineStatus } from "../use-online-status";
import { useApiTask } from "../api-task-provider";
import { Checkbox } from "../ui/choice";
import { SecretInput } from "../ui/secret-input";
import { Button, TextField } from "../ui/controls";
import { ProductMark } from "../components/product-mark";

interface LoginPageProps {
  onLogin?: (password: string, remember: boolean) => Promise<LoginResponse | void>;
  onVerify?: (code: string, recovery: boolean) => Promise<void>;
}

/**
 * 展示 BugPaw 品牌登录入口，只有完整通过第二因素才进入工作台。
 */
export function LoginPage({ onLogin, onVerify }: LoginPageProps) {
  const online = useOnlineStatus();
  const lock = useRef(false);
  const [challenge, setChallenge] = useState<string>();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (!challenge) return;
    const timer = window.setTimeout(() => { setChallenge(undefined); setCode(""); setError("登录验证已过期，请重新输入访问密码。"); }, Math.max(0, Date.parse(challenge) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [challenge]);
  const { runApiTask } = useApiTask();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onLogin || lock.current || !online) return;
    const data = new FormData(event.currentTarget);
    setError("");
    lock.current = true;
    setSubmitting(true);
    try {
      const result = await runApiTask(
        async () => {
          if (challenge) {
            if (!onVerify) return;
            await onVerify(code, recovery);
            return;
          }
          return onLogin(String(data.get("password") ?? ""), remember);
        },
        {
          operation: challenge ? "验证登录第二因素" : "登录 BugPaw",
          expected: {
            INVALID_CREDENTIALS: (reason) => setError(reason.message),
            LOGIN_RATE_LIMITED: (reason) => setError(reason.message),
            TOTP_RATE_LIMITED: (reason) => setError(reason.message),
            TOTP_INVALID_CODE: (reason) => { setCode(""); setError(reason.message); },
            TOTP_CHALLENGE_EXPIRED: (reason) => { setChallenge(undefined); setCode(""); setError(reason.message); },
            TOTP_STATE_CONFLICT: (reason) => { setChallenge(undefined); setCode(""); setError(reason.message); },
            NOT_INITIALIZED: (reason) => setError(reason.message),
            INVALID_LOGIN_REQUEST: (reason) => setError(reason.message),
          },
        },
      );
      if (result.status === "success" && result.data?.authenticated === false) {
        setChallenge(result.data.expiresAt); setCode(""); setRecovery(false);
      }
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-brand-panel" aria-labelledby="login-brand-title">
        <div className="login-brand-top">
          <div>
            <ProductMark />
            <span className="brand-subtitle">YOUR AI AGENT · BUILT FOR DEVELOPERS</span>
          </div>
          <span className="private-state"><i aria-hidden="true" /> private by default</span>
        </div>

        <div className="hero-copy">
          <span className="hero-kicker">Built for developers</span>
          <h1 id="login-brand-title">让聪明的爪印，<br />留在你的代码里。</h1>
          <p>一个理解上下文、会使用工具，也能持续积累知识的本地 Agent 工作台。</p>
          <div className="hero-points" aria-label="产品特性">
            <span><HardDrive size={16} aria-hidden="true" /><strong>本地优先</strong></span>
            <span><Wrench size={16} aria-hidden="true" /><strong>工具原生</strong></span>
            <span><BookOpen size={16} aria-hidden="true" /><strong>知识增强</strong></span>
          </div>
        </div>

        <img
          className="hero-art"
          src="/brand/bugpaw/bugpaw-og-hero.png"
          alt="BUG 猫咪与 BugPaw 品牌像素插画"
        />

        <div className="login-brand-bottom">
          <span>BugPaw v0.1</span>
          <span>Made with a cat named BUG.</span>
        </div>
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <div className="mobile-brand">
            <ProductMark compact />
            <span className="brand-subtitle">YOUR AI AGENT · BUILT FOR DEVELOPERS</span>
          </div>

          <div className="login-heading">
            <span>Welcome back</span>
            <h2 id="login-title">{challenge ? (recovery ? "使用恢复码登录" : "验证你的身份") : "回到你的工作区"}</h2>
            <p className="login-intro">{challenge ? "访问密码已验证，请完成第二步验证。" : "输入访问密码，继续和 BugPaw 一起工作。"}</p>
          </div>

          {!online ? <p role="status">当前离线，连接服务后才能登录。</p> : null}
          <form className="login-form" onSubmit={submitLogin} aria-busy={submitting}>
            {challenge ? <label className="login-field" key={recovery ? "recovery" : "totp"}>
              <span>{recovery ? "一次性恢复码" : "6 位验证码"}</span>
              <TextField name="code" aria-label={recovery ? "一次性恢复码" : "6 位验证码"} value={code} onChange={(event) => setCode(event.target.value)} type="text" inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" pattern={recovery ? undefined : "[0-9]{6}"} maxLength={recovery ? 64 : 6} required autoFocus disabled={submitting} />
            </label> : <>

            <label className="login-field">
              <span>访问密码</span>
              <SecretInput name="password" visible={passwordVisible} onVisibilityChange={setPasswordVisible}
                autoComplete="current-password" aria-label="访问密码" required />
            </label>

            <div className="remember-row">
              <Checkbox label="保持登录" name="remember" checked={remember}
                onChange={(event) => setRemember(event.currentTarget.checked)} />
            </div>

            </>}

            <Button className="login-submit" variant="primary" type="submit" loading={submitting} disabled={!online}>
              {challenge ? "验证并登录" : "进入 BugPaw"}
              <ArrowRight size={18} aria-hidden="true" />
            </Button>
          </form>
          {challenge ? <div className="login-factor-actions"><button type="button" className="text-button" disabled={submitting} onClick={() => { setRecovery(!recovery); setCode(""); setError(""); }}>{recovery ? "使用验证器验证码" : "无法使用验证器？使用恢复码"}</button><button type="button" className="text-button" disabled={submitting} onClick={() => { setChallenge(undefined); setCode(""); setError(""); }}>返回密码登录</button></div> : null}

          {error ? <p className="login-error" role="alert">{error}</p> : null}

          <div className="login-security" id="login-security">
            <LockKeyhole size={17} aria-hidden="true" />
            <span><strong><Wifi size={13} aria-hidden="true" />连接到本地服务</strong>访问凭据不会离开当前部署环境。</span>
          </div>
        </div>

        <footer>© 2026 BugPaw <span>·</span> 私有部署工作台</footer>
      </section>
    </main>
  );
}

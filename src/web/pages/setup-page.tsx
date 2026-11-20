import { ArrowRight, Check, LockKeyhole } from "lucide-react";
import { useState } from "react";
import type { SetupRequest } from "../api";
import type { ThemePreference } from "../theme";
import { ProductMark } from "../components/product-mark";
import { ThemeSwitcher } from "../components/theme-switcher";
import { SecretInput } from "../ui/secret-input";
import { useApiTask } from "../api-task-provider";

interface SetupPageProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onComplete?: (input: SetupRequest) => Promise<void>;
}

const steps = ["设置密码", "连接模型", "开始使用"];

/**
 * 首次启动向导，分步收集访问密码与模型连接配置。
 */
export function SetupPage({ theme, onThemeChange, onComplete }: SetupPageProps) {
  const { runApiTask } = useApiTask();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [step, setStep] = useState<0 | 1>(0);
  const [credentials, setCredentials] = useState({ password: "", confirmPassword: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const continueToProvider = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextCredentials = {
      password: String(data.get("password") ?? ""),
      confirmPassword: String(data.get("passwordConfirm") ?? ""),
    };
    if (nextCredentials.password.length < 12) {
      setError("访问密码至少需要 12 个字符。");
      return;
    }
    if (nextCredentials.password !== nextCredentials.confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    setError("");
    setCredentials(nextCredentials);
    setStep(1);
  };

  const completeSetup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: SetupRequest = {
      ...credentials,
      provider: {
        type: String(data.get("provider") ?? "openai-compatible"),
        apiKey: String(data.get("apiKey") ?? ""),
        baseUrl: String(data.get("baseUrl") ?? "").trim() || undefined,
        defaultModel: String(data.get("defaultModel") ?? "").trim(),
      },
    };
    if (!input.provider.apiKey || !input.provider.defaultModel) {
      setError("请填写 API Key 和默认模型。");
      return;
    }
    if (!onComplete) {
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await runApiTask(
        () => onComplete(input),
        {
          operation: "初始化 BugPaw",
          expected: {
            INVALID_SETUP: (reason) => setError(reason.message),
            ALREADY_INITIALIZED: (reason) => setError(reason.message),
            VALIDATION_FAILED: (reason) => setError(reason.message),
          },
        },
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page setup-page">
      <section className="login-brand-panel setup-brand-panel" aria-labelledby="setup-context-title">
        <div className="login-brand-top setup-brand-top">
          <div>
            <ProductMark />
            <span className="brand-subtitle">YOUR AI AGENT · BUILT FOR DEVELOPERS</span>
          </div>
          <span className="private-state"><i aria-hidden="true" /> 首次设置</span>
        </div>

        <div className="hero-copy setup-hero-copy">
          <span className="hero-kicker">Get started</span>
          <h1 id="setup-context-title">几步完成设置，开始和 BugPaw 一起工作。</h1>
          <p>设置密码、连接模型，然后就可以开始和 BugPaw 一起工作。</p>
        </div>

        <ol className="setup-steps" aria-label="初始化步骤">
          {steps.map((stepName, index) => (
            <li key={stepName} className={index === step ? "is-current" : undefined}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stepName}</strong>
            </li>
          ))}
        </ol>

        <div className="hero-art setup-hero-art">
          <img
            src="/brand/bugpaw/bugpaw-og-hero.png"
            alt="BUG 猫咪与 BugPaw 品牌像素插画"
          />
        </div>

      </section>

      <section className="login-form-panel setup-form-panel" aria-labelledby="setup-title">
        <div className="setup-form-panel__theme">
          <ThemeSwitcher value={theme} onChange={onThemeChange} compact />
        </div>

        <div className="login-form-wrap">
          {step === 0 ? <>
            <div className="login-heading">
              <span>Initial setup · 1 / 3</span>
              <h2 id="setup-title">创建访问密码</h2>
              <p className="login-intro">设置一个访问密码，保护你的工作空间。</p>
            </div>

          <form className="login-form" onSubmit={continueToProvider}>
            <label className="login-field">
              <span>访问密码</span>
              <SecretInput name="password" aria-label="访问密码" visible={passwordVisible} onVisibilityChange={setPasswordVisible} autoComplete="new-password" placeholder="至少 12 个字符" minLength={12} required />
            </label>

            <label className="login-field">
              <span>确认密码</span>
              <SecretInput name="passwordConfirm" aria-label="确认密码" visible={confirmPasswordVisible} onVisibilityChange={setConfirmPasswordVisible} autoComplete="new-password" required />
            </label>

            <button className="login-submit" type="submit">
              继续
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          </> : <>
            <div className="login-heading">
              <span>Initial setup · 2 / 3</span>
              <h2 id="setup-title">连接你的模型</h2>
              <p className="login-intro">填写模型服务信息，完成后即可开始对话。</p>
            </div>

            <form className="login-form" onSubmit={completeSetup}>
              <label className="login-field">
                <span>模型服务</span>
                <select name="provider" defaultValue="openai-compatible">
                  <option value="openai-compatible">OpenAI Compatible</option>
                </select>
              </label>
              <label className="login-field">
                <span>API Key</span>
                <SecretInput name="apiKey" aria-label="API Key" visible={apiKeyVisible} onVisibilityChange={setApiKeyVisible} autoComplete="off" required />
              </label>
              <label className="login-field">
                <span>服务地址</span>
                <input name="baseUrl" type="url" defaultValue="https://api.openai.com/v1" required />
              </label>
              <label className="login-field">
                <span>使用的模型</span>
                <input name="defaultModel" type="text" placeholder="例如 gpt-5" required />
              </label>
              <button className="login-submit" type="submit" disabled={submitting}>
                {submitting ? "正在初始化…" : "完成初始化"}
                <Check size={18} aria-hidden="true" />
              </button>
            </form>
          </>}

          {error && <p className="login-error" role="alert">{error}</p>}

          <div className="login-security">
            <LockKeyhole size={17} aria-hidden="true" />
            <span>
              <strong><LockKeyhole size={13} aria-hidden="true" />保护你的工作空间</strong>
              {step === 0
                ? "设置一个只有你知道的访问密码，安心开始使用。"
                : "完成连接后即可开始对话，之后也可以随时调整。"}
            </span>
          </div>
        </div>

        <footer>© 2026 BugPaw <span>·</span> 你的 Agent 工作台</footer>
      </section>
    </main>
  );
}

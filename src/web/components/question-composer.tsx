import { ChevronLeft, ChevronRight, Minus, Send } from "lucide-react";
import { Checkbox, Radio } from "../ui/choice";
import { Button, IconButton, Textarea } from "../ui/controls";

import type { PendingQuestionProjection, SubmittedQuestionAnswer } from "../../shared/session-question-contracts";
import type { QuestionDraftController } from "../use-question-draft";

interface QuestionComposerProps {
  pending: PendingQuestionProjection;
  draft: QuestionDraftController;
  submitting: boolean;
  error?: string;
  onCollapse(): void;
  onSubmit(answers: SubmittedQuestionAnswer[]): void;
}

/** 在原输入区域逐题处理 Agent 提问，并允许用户随时提前提交。 */
export function QuestionComposer({ pending, draft, submitting, error, onCollapse, onSubmit }: QuestionComposerProps) {
  const questionIndex = Math.min(draft.draft.questionIndex, pending.questions.length - 1);
  const question = pending.questions[questionIndex];
  const Choice = question.multiSelect ? Checkbox : Radio;
  const answer = draft.draft.answers[question.id] ?? { optionIds: [], text: "" };
  const submitLabel = submitting
    ? "正在提交回答"
    : draft.answeredCount === 0
      ? "暂不回答并提交"
      : `提交已回答的 ${draft.answeredCount}/${pending.questions.length} 题`;

  return <form className="question-composer" onSubmit={(event) => {
    event.preventDefault();
    if (!submitting) onSubmit(draft.buildSubmission());
  }}>
    <header className="question-composer__header">
      <div>
        <span>AGENT 提问</span>
        <strong>{question.header}</strong>
      </div>
      <div className="question-composer__status" aria-live="polite">
        <span>问题 {questionIndex + 1}/{pending.questions.length}</span>
        <span>已回答 {draft.answeredCount}/{pending.questions.length}</span>
      </div>
      <IconButton className="question-composer__collapse" disabled={submitting} onClick={onCollapse} label="收起提问处理框">
        <Minus size={17} aria-hidden="true" />
      </IconButton>
    </header>

    <fieldset className="question-composer__question" disabled={submitting}>
      <legend>{question.question}</legend>
      <div className="question-composer__options">
        {question.options.map((option) => <Choice
          key={option.id}
          name={`question-${question.id}`}
          checked={answer.optionIds.includes(option.id)}
          onChange={() => draft.toggleOption(question.id, option.id)}
          label={<span><strong>{option.label}</strong><small>{option.description}</small></span>}
        />)}
      </div>
      <label className="question-composer__text">
        <span>其他回答（可选）</span>
        <Textarea
          value={answer.text}
          maxLength={10_000}
          rows={2}
          placeholder="也可以直接输入你的回答"
          onChange={(event) => draft.setText(question.id, event.target.value)}
        />
      </label>
    </fieldset>

    {error ? <p className="question-composer__error" role="alert">{error}</p> : null}
    <footer className="question-composer__footer">
      <div className="question-composer__navigation">
        <Button disabled={submitting || questionIndex === 0} onClick={() => draft.setQuestionIndex(questionIndex - 1)}>
          <ChevronLeft size={16} aria-hidden="true" />上一题
        </Button>
        <Button disabled={submitting || questionIndex === pending.questions.length - 1} onClick={() => draft.setQuestionIndex(questionIndex + 1)}>
          下一题<ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
      <Button type="submit" variant="primary" className="question-composer__submit" loading={submitting} aria-label={submitLabel}>
        <Send size={16} aria-hidden="true" />{submitLabel}
      </Button>
    </footer>
  </form>;
}

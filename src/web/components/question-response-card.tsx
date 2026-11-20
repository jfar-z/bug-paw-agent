import { useState } from "react";

import type { QuestionResolution } from "../../shared/question-response-protocol";
import type { PendingQuestionProjection, SubmittedQuestionAnswer } from "../../shared/session-question-contracts";
import { QuestionStepTabs } from "./question-step-tabs";

interface QuestionResponseCardProps {
  pendingQuestion: PendingQuestionProjection;
  resolution: QuestionResolution;
}

interface AnswerDetails {
  value: string;
  descriptions: string[];
}

/** 在独立用户消息中逐题展示 Agent 实际收到的结构化回答。 */
export function QuestionResponseCard({ pendingQuestion, resolution }: QuestionResponseCardProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const question = pendingQuestion.questions[activeIndex] ?? pendingQuestion.questions[0];
  const answer = resolution.answers.find((item) => item.questionId === question.id);
  const details = readAnswerDetails(question, answer, resolution.status);

  return <section className="question-timeline-card question-response-card" aria-label="用户回答">
    <header>
      <strong>{resolution.status === "submitted" ? "已提交回答" : "已放弃回答"}</strong>
      <span>共 {pendingQuestion.questions.length} 个问题</span>
    </header>
    <QuestionStepTabs
      count={pendingQuestion.questions.length}
      activeIndex={activeIndex}
      onChange={setActiveIndex}
      label="用户回答题目"
    >
      <div className="question-response-card__detail">
        <div className="question-response-card__question">
          <span>{question.header} · 第 {activeIndex + 1} 题</span>
          <strong>{question.question}</strong>
        </div>
        <div className="question-response-card__answer">
          <span>Agent 实际收到</span>
          <strong>{details.value}</strong>
          {details.descriptions.map((description) => <p key={description}>{description}</p>)}
        </div>
        <span className="question-response-card__summary">
          未回答 {resolution.unansweredQuestionIds.length} 题
        </span>
      </div>
    </QuestionStepTabs>
  </section>;
}

/** 将权威答案映射为 Agent 协议实际包含的可读内容。 */
function readAnswerDetails(
  question: PendingQuestionProjection["questions"][number],
  answer: SubmittedQuestionAnswer | undefined,
  status: QuestionResolution["status"],
): AnswerDetails {
  if (status === "discarded") return { value: "未提交回答", descriptions: [] };
  if (!answer) return { value: "未回答", descriptions: [] };
  if (answer.kind === "text") return { value: answer.text, descriptions: [] };

  const selected = answer.optionIds.map((optionId) =>
    question.options.find((option) => option.id === optionId));
  if (selected.some((option) => !option)) {
    return { value: "回答数据不可用", descriptions: [] };
  }
  return {
    value: selected.map((option) => option!.label).join("、"),
    descriptions: selected.map((option) => option!.description),
  };
}

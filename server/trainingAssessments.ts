import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { isRhAdmin, type RhViewer } from './rhAccess';

export const assessmentAnswers = z.array(z.object({
  questionId: z.number().int().positive(), answer: z.enum(['A', 'B', 'C', 'D']),
})).max(500).superRefine((answers, ctx) => {
  if (new Set(answers.map(a => a.questionId)).size !== answers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cada pergunta só pode ter uma resposta.' });
  }
});

export function gradeAssessment(
  questions: { id: number; correctOption: string; points: number }[],
  answers: { questionId: number; answer: string }[],
) {
  if (!questions.length || questions.some(q => !Number.isInteger(q.points) || q.points <= 0)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A avaliação não tem perguntas e pontuações válidas.' });
  }
  const map = new Map(questions.map(q => [q.id, q]));
  if (new Set(answers.map(a => a.questionId)).size !== answers.length || answers.some(a => !map.has(a.questionId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'As respostas contêm perguntas repetidas ou que não pertencem à avaliação.' });
  }
  let correct = 0, score = 0;
  for (const answer of answers) {
    const question = map.get(answer.questionId)!;
    if (question.correctOption === answer.answer) { correct++; score += question.points; }
  }
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
  return { correct, score, percentage: Math.round(score * 100 / totalPoints), total: questions.length };
}

export function trainingResultScope(viewer: RhViewer) {
  return isRhAdmin(viewer) ? undefined : {
    employeeId: viewer.employeeId,
    projectIds: viewer.role === 'supervisor' ? viewer.scopeProjectIds ?? [] : [],
  };
}

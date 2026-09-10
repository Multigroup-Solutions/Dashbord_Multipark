import { describe, expect, it } from 'vitest';
import { assessmentAnswers, gradeAssessment, trainingResultScope } from './trainingAssessments';

const questions = [{ id: 1, correctOption: 'A', points: 10 }, { id: 2, correctOption: 'B', points: 30 }];
describe('integridade das avaliações', () => {
  it('rejeita identificadores repetidos antes de guardar resultados', () => {
    const answers = [{ questionId: 1, answer: 'A' }, { questionId: 1, answer: 'A' }];
    expect(assessmentAnswers.safeParse(answers).success).toBe(false);
    expect(() => gradeAssessment(questions, answers)).toThrow(/repetidas/);
  });
  it('rejeita perguntas de outro exame em vez de as ignorar', () => {
    expect(() => gradeAssessment(questions, [{ questionId: 99, answer: 'A' }])).toThrow(/não pertencem/);
  });
  it('usa todos os pontos do exame mesmo com respostas em falta', () => {
    expect(gradeAssessment(questions, [{ questionId: 1, answer: 'A' }])).toEqual({ correct: 1, score: 10, percentage: 25, total: 2 });
    expect(gradeAssessment(questions, [])).toMatchObject({ score: 0, percentage: 0, total: 2 });
  });
  it('uma resposta certa por pergunta produz no máximo 100%', () => {
    expect(gradeAssessment(questions, [{ questionId: 1, answer: 'A' }, { questionId: 2, answer: 'B' }])).toMatchObject({ correct: 2, percentage: 100 });
  });
  it('recusa avaliações sem perguntas ou com pontuações inválidas', () => {
    expect(() => gradeAssessment([], [])).toThrow();
    expect(() => gradeAssessment([{ id: 1, correctOption: 'A', points: -10 }], [])).toThrow();
  });
});

describe('âmbito dos resultados', () => {
  const viewer = { id: 1, employeeId: 7, scopeProjectIds: [10, 11] };
  it.each(['extra', 'frontoffice', 'backoffice', 'team_leader'])('%s vê apenas os seus resultados', role => {
    expect(trainingResultScope({ ...viewer, role })).toEqual({ employeeId: 7, projectIds: [] });
  });
  it('o supervisor vê o próprio e os centros que gere', () => {
    expect(trainingResultScope({ ...viewer, role: 'supervisor' })).toEqual({ employeeId: 7, projectIds: [10, 11] });
  });
  it('sem ficha nem centros, o supervisor não recebe acesso global', () => {
    expect(trainingResultScope({ id: 1, employeeId: null, scopeProjectIds: null, role: 'supervisor' })).toEqual({ employeeId: null, projectIds: [] });
  });
  it.each(['admin', 'super_admin'])('%s mantém o acesso de gestão', role => {
    expect(trainingResultScope({ ...viewer, role })).toBeUndefined();
  });
});

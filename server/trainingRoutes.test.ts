import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ saveQuiz: vi.fn(), saveExam: vi.fn(), attempts: vi.fn(), notify: vi.fn(), archive: vi.fn() }));
vi.mock('./db', async original => ({
  ...await original<object>(),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 7, projectId: 10, fullName: 'Colaborador teste' } }),
  resolveProjectIds: async () => [10, 11],
  getCareerExams: async () => [{ id: 1, title: 'Exame teste', passingScore: 70 }],
  getQuizQuestions: async () => [{ id: 1, correctOption: 'A', points: 10 }],
  getCareerExamQuestions: async () => [{ id: 1, correctOption: 'A', points: 10 }],
  saveQuizAttempt: f.saveQuiz, saveCareerExamAttempt: f.saveExam, getCareerExamAttempts: f.attempts,
  deleteCareerExam: f.archive, logActivity: vi.fn(),
}));
vi.mock('./_core/notification', () => ({ notifyOwner: f.notify }));
import { appRouter } from './routers';
const caller = (role = 'extra') => appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);
beforeEach(() => {
  vi.clearAllMocks(); f.saveQuiz.mockResolvedValue({ id: 1 }); f.saveExam.mockResolvedValue({ id: 2 });
  f.attempts.mockResolvedValue([]); f.notify.mockResolvedValue(true);
});
describe('rotas de avaliações', () => {
  it('não grava quiz nem exame com respostas repetidas', async () => {
    const answers = [{ questionId: 1, answer: 'A' as const }, { questionId: 1, answer: 'A' as const }];
    await expect(caller().training.submitQuiz({ answers })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().training.submitCareerExam({ examId: 1, answers })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.saveQuiz).not.toHaveBeenCalled(); expect(f.saveExam).not.toHaveBeenCalled();
  });
  it('rejeita perguntas de outro exame e quiz vazio', async () => {
    await expect(caller().training.submitCareerExam({ examId: 1, answers: [{ questionId: 9, answer: 'A' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().training.submitQuiz({ answers: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.saveExam).not.toHaveBeenCalled(); expect(f.saveQuiz).not.toHaveBeenCalled();
  });
  it('não transforma falha do aviso em falha de um resultado já guardado', async () => {
    f.notify.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(caller().training.submitCareerExam({ examId: 1, answers: [{ questionId: 1, answer: 'A' }] })).resolves.toMatchObject({ id: 2, score: 100, passed: true });
    expect(f.saveExam).toHaveBeenCalledOnce();
    expect(f.saveExam).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, score: 100 }));
  });
  it('aplica âmbito próprio mesmo que frontoffice peça outro colaborador', async () => {
    await caller('frontoffice').training.careerExamAttempts({ employeeId: 999 });
    expect(f.attempts).toHaveBeenCalledWith(999, undefined, { employeeId: 7, projectIds: [] });
  });
  it('limita supervisores aos seus centros e preserva o acesso dos administradores', async () => {
    await caller('supervisor').training.careerExamAttempts({});
    expect(f.attempts).toHaveBeenLastCalledWith(undefined, undefined, { employeeId: 7, projectIds: [10, 11] });
    await caller('admin').training.careerExamAttempts({});
    expect(f.attempts).toHaveBeenLastCalledWith(undefined, undefined, undefined);
  });
  it('mantém o arquivo reservado ao perfil autorizado', async () => {
    await expect(caller('admin').training.deleteCareerExam({ id: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.archive).not.toHaveBeenCalled();
    await expect(caller('super_admin').training.deleteCareerExam({ id: 1 })).resolves.toEqual({ success: true });
    expect(f.archive).toHaveBeenCalledOnce();
  });
});

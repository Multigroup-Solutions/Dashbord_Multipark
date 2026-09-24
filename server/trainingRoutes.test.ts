import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./cityAccess', async original => ({ ...await original<object>(), loadCityAccess: async () => ({ all: true, cityIds: [10], projectIds: [10, 11], missingCostCenter: false }) }));
const f = vi.hoisted(() => ({ attempts: vi.fn(), notify: vi.fn(), archive: vi.fn(), submit: vi.fn(), startExam: vi.fn(), startQuiz: vi.fn() }));
vi.mock('./db', async original => ({
  ...await original<object>(),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 7, projectId: 10, fullName: 'Colaborador teste' } }),
  resolveProjectIds: async () => [10, 11],
  getCareerExams: async () => [{ id: 1, title: 'Exame teste', passingScore: 70 }],
  getCareerExamAttempts: f.attempts,
  deleteCareerExam: f.archive, logActivity: vi.fn(),
}));
vi.mock('./trainingAttempts', () => ({ submitAttempt: f.submit, startExamAttempt: f.startExam, startQuizAttempt: f.startQuiz }));
vi.mock('./_core/notification', () => ({ notifyOwner: f.notify }));
import { appRouter } from './routers';
const caller = (role = 'extra') => appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);
beforeEach(() => {
  vi.clearAllMocks();
  f.attempts.mockResolvedValue([]); f.notify.mockResolvedValue(true);
  f.submit.mockResolvedValue({ kind: 'exam', passed: true, percentage: 100, passingScore: 70, review: [] });
  f.startExam.mockResolvedValue({ sessionId: 5, questions: [] });
});
describe('rotas de avaliações', () => {
  it('não aceita respostas repetidas (validação do input)', async () => {
    const answers = [{ questionId: 1, answer: 'A' as const }, { questionId: 1, answer: 'A' as const }];
    await expect(caller().training.submitQuiz({ sessionId: 1, answers })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().training.submitCareerExam({ sessionId: 1, answers })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.submit).not.toHaveBeenCalled();
  });
  it('a tentativa é sempre do próprio (employeeId da sessão, não do cliente)', async () => {
    await caller().training.startCareerExam({ examId: 1 });
    expect(f.startExam).toHaveBeenCalledWith(7, 1);
    await caller().training.submitCareerExam({ sessionId: 5, answers: [{ questionId: 1, answer: 'A' }] });
    expect(f.submit).toHaveBeenCalledWith(7, 5, [{ questionId: 1, answer: 'A' }]);
  });
  it('não transforma falha do aviso em falha de um resultado já guardado', async () => {
    f.notify.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(caller().training.submitCareerExam({ sessionId: 5, answers: [{ questionId: 1, answer: 'A' }] })).resolves.toMatchObject({ passed: true, percentage: 100 });
  });
  it('recusa usar uma tentativa de exame como quiz', async () => {
    await expect(caller().training.submitQuiz({ sessionId: 5, answers: [{ questionId: 1, answer: 'A' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
  it('gestão de percursos e dashboard exigem supervisor/admin', async () => {
    await expect(caller('extra').training.dashboard()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('supervisor').training.createPath({ name: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin').training.deleteCategory({ id: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

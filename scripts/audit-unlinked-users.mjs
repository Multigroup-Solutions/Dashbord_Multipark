/** Read-only email cross-check. Reports contain personal data: save outside the repository. */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--env') || !process.argv.includes('--report')) throw new Error('Usa --env ficheiro --report relatorio.json');
dotenv.config({ path: argument('--env'), quiet: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL em falta');
const connection = await mysql.createConnection(process.env.DATABASE_URL);
const query = async (sql, values = []) => (await connection.query({ sql, values, timeout: 60000 }))[0];
try {
  await query('SET SESSION TRANSACTION READ ONLY');
  await query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  const allUsers = await query(`SELECT u.id, u.name, u.email, u.role, u.isActive, u.department, u.loginMethod, u.lastSignedIn
    FROM users u WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.userId = u.id) ORDER BY u.isActive DESC, u.id`);
  const excluded = new Set(process.argv.includes('--exclude-users') ? argument('--exclude-users').split(',').map(Number) : []);
  const users = allUsers.filter(u => !excluded.has(u.id));
  const normalize = value => String(value ?? '').trim().toLowerCase();
  const emails = [...new Set(users.map(u => normalize(u.email)).filter(Boolean))];
  const placeholders = emails.map(() => '?').join(',');
  const employees = emails.length ? await query(`SELECT e.id, e.fullName, e.email, e.personalEmail, e.userId,
    e.isActive, e.projectId, p.name AS costCenter, e.multiparkAgentUserId, linked.email AS linkedUserEmail
    FROM employees e LEFT JOIN projects p ON p.id = e.projectId LEFT JOIN users linked ON linked.id = e.userId
    WHERE LOWER(TRIM(e.email)) IN (${placeholders}) OR LOWER(TRIM(e.personalEmail)) IN (${placeholders})`, [...emails, ...emails]) : [];
  const applications = emails.length ? await query(`SELECT id, fullName, email, city, status, employeeId, lastSubmittedAt
    FROM driver_applications WHERE LOWER(TRIM(email)) IN (${placeholders})`, emails) : [];
  // Same display name / local part across different domains is only a candidate,
  // never proof of identity or authority to assign a cost centre.
  const candidates = users.length ? await query(`SELECT u.id AS orphanUserId, e.id, e.fullName, e.email, e.personalEmail,
    e.userId, e.isActive, e.projectId, p.name AS costCenter, linked.email AS linkedUserEmail
    FROM users u JOIN employees e ON (
      (TRIM(u.name) <> '' AND LOWER(TRIM(e.fullName)) = LOWER(TRIM(u.name))) OR
      (LOCATE('@', u.email) > 5 AND LOWER(SUBSTRING_INDEX(TRIM(e.email), '@', 1)) = LOWER(SUBSTRING_INDEX(TRIM(u.email), '@', 1))))
    LEFT JOIN projects p ON p.id = e.projectId LEFT JOIN users linked ON linked.id = e.userId
    WHERE u.id IN (${users.map(() => '?').join(',')})`, users.map(u => u.id)) : [];
  const activity = emails.length ? await query(`SELECT LOWER(TRIM(h.agentEmail)) AS email, h.agentUserId,
    GROUP_CONCAT(DISTINCT h.agentName ORDER BY h.agentName SEPARATOR ' | ') AS agentNames,
    b.projectId, p.name AS costCenter, COUNT(DISTINCT h.id) AS actions, MIN(h.actionTime) AS firstAction, MAX(h.actionTime) AS lastAction
    FROM multipark_booking_history h LEFT JOIN multipark_bookings b ON b.externalId = h.bookingExternalId
    LEFT JOIN projects p ON p.id = b.projectId
    WHERE LOWER(TRIM(h.agentEmail)) IN (${placeholders})
    GROUP BY LOWER(TRIM(h.agentEmail)), h.agentUserId, b.projectId, p.name`, emails) : [];
  const report = { ranAt: new Date().toISOString(), readOnly: true, counts: {
    usersWithoutEmployee: allUsers.length, activeWithoutEmployee: allUsers.filter(u => u.isActive).length,
    excludedFromReport: allUsers.length - users.length,
  }, users: users.map(user => ({ ...user,
    employeeMatches: employees.filter(e => [e.email, e.personalEmail].some(value => normalize(value) === normalize(user.email))),
    applications: applications.filter(a => normalize(a.email) === normalize(user.email)),
    candidatesWithDifferentEmail: candidates.filter(e => e.orphanUserId === user.id && ![e.email, e.personalEmail].some(value => normalize(value) === normalize(user.email))),
    activity: activity.filter(a => normalize(a.email) === normalize(user.email)),
  })) };
  const output = path.resolve(argument('--report'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report.counts, exactEmployeeMatches: report.users.filter(u => u.employeeMatches.length).length,
    applicationMatches: report.users.filter(u => u.applications.length).length, activityMatches: report.users.filter(u => u.activity.length).length, report: output }));
} finally {
  await connection.rollback();
  await connection.end();
}

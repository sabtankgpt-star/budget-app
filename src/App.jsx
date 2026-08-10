import React, { useState, useEffect, useMemo, useRef, useContext, createContext } from 'react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, LabelList } from 'recharts';
import {
  Wallet, Plus, Settings2, RotateCcw, X, ArrowRight,
  TrendingUp, TrendingDown, Minus, ChevronLeft, Check, Loader2,
  Sun, Moon, Calculator, Pencil, Flame, Award, AlertTriangle, Sparkles, Calendar, Share2, Smartphone, Info, HelpCircle, BookOpen, Lock, LogOut,
} from 'lucide-react';
import { supabase } from './lib/supabaseClient';

const STORAGE_KEY = 'nazariyat-mutawassit-v3';

const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

/* ---------- calendar-aware payday cycle math ---------- */
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const clampDay = (y, m, dom) => Math.min(dom, daysInMonth(y, m));
const dateAtDom = (y, m, dom) => new Date(y, m, clampDay(y, m, dom));
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const diffDays = (a, b) => Math.round((b - a) / 86400000);

function addCycleMonths(date, delta, dom) {
  let y = date.getFullYear();
  let m = date.getMonth() + delta;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return dateAtDom(y, m, dom);
}
function findCycleStart(today, dom) {
  const thisMonth = dateAtDom(today.getFullYear(), today.getMonth(), dom);
  if (thisMonth.getTime() <= today.getTime()) return thisMonth;
  return addCycleMonths(thisMonth, -1, dom);
}

const DARK = {
  name: 'dark', ink: '#000000', surface: '#131313', surface2: '#1E1E1E',
  line: 'rgba(255,255,255,0.08)', paper: '#F2F1ED', muted: '#8C8C8C',
  good: '#3ED9A0', warn: '#F5B84B', bad: '#FF5C5C',
};
const LIGHT = {
  name: 'light', ink: '#F6F3EC', surface: '#FFFFFF', surface2: '#EFEAE0',
  line: 'rgba(27,27,27,0.08)', paper: '#1B1B1B', muted: '#7C7C7C',
  good: '#1FA37E', warn: '#B9791E', bad: '#D8483E',
};

const ThemeCtx = createContext(DARK);
const useColors = () => useContext(ThemeCtx);

function statusOf(dailyBudget, baseline) {
  if (baseline <= 0) return 'bad';
  const ratio = dailyBudget / baseline;
  if (ratio >= 0.7) return 'good';
  if (ratio >= 0.35) return 'warn';
  return 'bad';
}
function statusMeta(status, name) {
  const n = name ? ` يا ${name}` : '';
  if (status === 'good') return { label: `أداؤك رائع${n} 🔥`, sub: 'أنت أفضل من متوسطك المعتاد' };
  if (status === 'warn') return { label: `انتبه شوي${n}`, sub: 'صرفك بدأ يقترب من الحد' };
  return { label: `تجاوزت المعدل${n}`, sub: 'خفف الصرف عشان يرجع المتوسط يرتفع' };
}

function computeStats(checkinsSorted, originalNetStart, totalDays) {
  if (!checkinsSorted.length) return null;
  let prevDay = 0, prevBalance = originalNetStart, cumNetStart = originalNetStart;
  const results = [];
  checkinsSorted.forEach((c) => {
    const intervalDays = Math.max(1, c.day - prevDay);
    const income = c.extraIncome || 0;
    // real spend that day, isolated from any income landing the same day
    const spend = prevBalance + income - c.balance;
    const avgDaily = spend / intervalDays;
    const neutral = !!income;
    // baseline for judging THIS day only reflects income received up to and including this day —
    // income from a later day should never retroactively make an earlier day look better or worse
    cumNetStart += income;
    const dayBaseline = totalDays ? cumNetStart / totalDays : 0;
    results.push({ day: c.day, spend, avgDaily, good: neutral ? null : avgDaily <= dayBaseline, neutral });
    prevDay = c.day; prevBalance = c.balance;
  });
  const scored = results.filter((r) => !r.neutral);
  const goodCount = scored.filter((r) => r.good).length;
  const complianceRate = scored.length ? Math.round((goodCount / scored.length) * 100) : 0;
  let best = scored[0] || null, worst = scored[0] || null;
  scored.forEach((r) => {
    if (r.avgDaily < best.avgDaily) best = r;
    if (r.avgDaily > worst.avgDaily) worst = r;
  });
  let longestStreak = 0, run = 0;
  scored.forEach((r) => { if (r.good) { run += 1; longestStreak = Math.max(longestStreak, run); } else run = 0; });
  let currentStreak = 0;
  for (let i = scored.length - 1; i >= 0; i--) { if (scored[i].good) currentStreak++; else break; }
  return { results, scored, complianceRate, best, worst, currentStreak, longestStreak };
}

/* ---------- Supabase-backed cycle history — the only permanent record of past cycles ---------- */
async function upsertCycleRow(userId, s) {
  try {
    await supabase.from('cycles').upsert({
      user_id: userId,
      cycle_start_date: s.cycleStart,
      net_start: Math.round(s.originalNetStart ?? s.netStart),
      payday_dom: s.paydayDom,
      name: s.name,
    }, { onConflict: 'user_id,cycle_start_date' });
  } catch (e) {}
}

async function fetchCyclesList(userId) {
  try {
    const { data, error } = await supabase
      .from('cycles')
      .select('cycle_start_date, net_start, payday_dom, name')
      .eq('user_id', userId)
      .order('cycle_start_date', { ascending: true });
    return error ? [] : (data || []);
  } catch (e) { return []; }
}

// reconstructs the same { setup, checkins } shape the local cycleHistory archive used to
// produce, but sourced entirely from the real tables — net_start stays the fixed original
// baseline for that cycle, and extra-income days carry extraIncome so computeStats keeps
// excluding them from compliance the same way it always has
async function fetchCycleDetail(userId, cycleStartIso) {
  try {
    const [{ data: cycleRows }, { data: checkinRows }] = await Promise.all([
      supabase.from('cycles').select('*').eq('user_id', userId).eq('cycle_start_date', cycleStartIso).limit(1),
      supabase.from('daily_checkins').select('*').eq('user_id', userId).eq('cycle_start_date', cycleStartIso).order('checkin_date', { ascending: true }),
    ]);
    const cycleRow = cycleRows && cycleRows[0];
    if (!cycleRow) return null;
    const cycleStartDate = parseISO(cycleStartIso);
    const checkins = (checkinRows || []).map((row) => {
      const extra = Number(row.extra_incomen) || 0;
      return {
        day: diffDays(cycleStartDate, parseISO(row.checkin_date)),
        balance: row.balance,
        note: row.note || '',
        extraIncome: extra > 0 ? extra : undefined,
      };
    });
    const extraTotal = checkins.reduce((sum, c) => sum + (c.extraIncome || 0), 0);
    const setup = {
      name: cycleRow.name || '',
      netStart: cycleRow.net_start + extraTotal,
      originalNetStart: cycleRow.net_start,
      paydayDom: cycleRow.payday_dom,
      cycleStart: cycleStartIso,
    };
    return { setup, checkins };
  } catch (e) { return null; }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [setup, setSetup] = useState(null); // { netStart, paydayDom, cycleStart }
  const [checkins, setCheckins] = useState([]);
  const [cycleHistory, setCycleHistory] = useState([]); // [{ setup, checkins }]
  const [dbCycles, setDbCycles] = useState([]); // [{ cycle_start_date, net_start, payday_dom, name }] from Supabase
  const [historyArchived, setHistoryArchived] = useState(null); // { setup, checkins } fetched from Supabase for the viewed month
  const [historyLoading, setHistoryLoading] = useState(false);
  const [bills, setBills] = useState([]); // [{ id, name, amount, dueDay }]
  const [goals, setGoals] = useState([]); // [{ id, name, target, saved }]
  const [view, setView] = useState('welcome');
  const [confirmReset, setConfirmReset] = useState(false);

  const [nameInput, setNameInput] = useState('');
  const [netInput, setNetInput] = useState('');
  const [paydayInput, setPaydayInput] = useState('1');
  const [showCalc, setShowCalc] = useState(false);
  const [salaryCalc, setSalaryCalc] = useState('');
  const [commitDraft, setCommitDraft] = useState([]);
  const [commitName, setCommitName] = useState('');
  const [commitAmount, setCommitAmount] = useState('');

  const [selectedDay, setSelectedDay] = useState(0);
  const [entryBalance, setEntryBalance] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [showExtraIncome, setShowExtraIncome] = useState(false);
  const [extraIncomeInput, setExtraIncomeInput] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [newCycleInput, setNewCycleInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');

  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // supabase-js's automatic hash-based session detection swallows any error from
        // validating the returned token, so we parse the OAuth callback hash ourselves —
        // this is the only way to actually surface what went wrong instead of just
        // silently landing back on the login screen
        if (window.location.hash) {
          const hashParams = new URLSearchParams(window.location.hash.slice(1));
          const errorDescription = hashParams.get('error_description') || hashParams.get('error');
          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');
          if (errorDescription) {
            setAuthError(errorDescription);
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
          } else if (accessToken && refreshToken) {
            const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
            if (error) {
              setAuthError(error.message);
            } else {
              setSession(data.session);
            }
          }
        }

        const { data } = await supabase.auth.getSession();
        setSession((current) => current || data.session);
      } catch (e) {
        setAuthError(e.message || String(e));
      } finally {
        setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    (async () => {
      try {
        const userId = session?.user?.id;
        // the real source of truth for "has this account ever onboarded" is the
        // cycles table, not localStorage — a device can carry stale/unrelated local
        // data (e.g. from testing, or a previous account on a shared device) that
        // must never be mistaken for this account's history
        const userCycles = userId ? await fetchCyclesList(userId) : [];
        const hasOnboardedBefore = userCycles.length > 0;
        setDbCycles(userCycles);

        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed) {
          if (parsed.theme) setTheme(parsed.theme);
          if (parsed.cycleHistory) setCycleHistory(parsed.cycleHistory);
          if (parsed.bills) setBills(parsed.bills);
          if (parsed.goals) setGoals(parsed.goals);
        }

        if (!hasOnboardedBefore) {
          // this account has never finished onboarding — show the one-time
          // account-welcome (+ optional phone number) screen before anything else
          setView('account-welcome');
        } else if (parsed?.setup) {
          setSetup(parsed.setup);
          setCheckins(parsed.checkins || []);
          setView('dashboard');
          const cs = parseISO(parsed.setup.cycleStart);
          const today = startOfDay(new Date());
          const idx = diffDays(cs, today);
          const cycleEnd = addCycleMonths(cs, 1, parsed.setup.paydayDom);
          const totalDays = diffDays(cs, cycleEnd);
          const clampedIdx = Math.max(0, Math.min(totalDays - 1, idx));
          setSelectedDay(clampedIdx);
          const existing = (parsed.checkins || []).find((c) => c.day === clampedIdx);
          setEntryBalance(existing ? String(existing.rawBalance ?? existing.balance) : '');
          setEntryNote(existing ? existing.note || '' : '');

          if (userId) {
            try {
              const { data, error } = await supabase
                .from('daily_checkins')
                .select('balance, note, extra_incomen')
                .eq('user_id', userId)
                .order('id', { ascending: false })
                .limit(1);
              if (!error && data && data[0]) {
                const row = data[0];
                setEntryBalance(String(row.balance));
                setEntryNote(row.note || '');
                const extra = Number(row.extra_incomen) || 0;
                setExtraIncomeInput(extra > 0 ? String(extra) : '');
                setShowExtraIncome(extra > 0);
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
      finally { setReady(true); }
    })();
  }, [authChecked]);

  async function persist(patch) {
    const payload = {
      theme: patch.theme !== undefined ? patch.theme : theme,
      setup: patch.setup !== undefined ? patch.setup : setup,
      checkins: patch.checkins !== undefined ? patch.checkins : checkins,
      cycleHistory: patch.cycleHistory !== undefined ? patch.cycleHistory : cycleHistory,
      bills: patch.bills !== undefined ? patch.bills : bills,
      goals: patch.goals !== undefined ? patch.goals : goals,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
  }

  async function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await persist({ theme: next });
  }

  const today = startOfDay(new Date());
  const cycleStartDate = setup ? parseISO(setup.cycleStart) : null;
  const actualCycleStart = setup ? findCycleStart(today, setup.paydayDom) : null;
  const cycleRolled = setup && actualCycleStart.getTime() !== cycleStartDate.getTime();

  const cycleEndDate = setup ? addCycleMonths(cycleStartDate, 1, setup.paydayDom) : null;
  const totalDays = setup ? diffDays(cycleStartDate, cycleEndDate) : 30;
  const todayIndex = setup ? Math.max(0, Math.min(totalDays - 1, diffDays(cycleStartDate, today))) : 0;
  const daysRemaining = setup ? Math.max(1, totalDays - todayIndex) : 1;
  const baselineDaily = setup ? setup.netStart / totalDays : 0;

  const sortedCheckins = useMemo(() => [...checkins].sort((a, b) => a.day - b.day), [checkins]);
  const latestCheckin = useMemo(() => {
    const past = sortedCheckins.filter((c) => c.day <= todayIndex);
    return past.length ? past[past.length - 1] : null;
  }, [sortedCheckins, todayIndex]);

  const effectiveBalance = latestCheckin ? latestCheckin.balance : (setup ? setup.netStart : 0);
  const dailyBudget = daysRemaining > 0 ? effectiveBalance / daysRemaining : effectiveBalance;
  const status = setup ? statusOf(dailyBudget, baselineDaily) : 'good';

  const pulseData = useMemo(() => {
    if (!setup) return [];
    const points = [{ seq: 0, value: baselineDaily }];
    sortedCheckins.forEach((c, i) => {
      const remain = Math.max(1, totalDays - c.day);
      points.push({ seq: i + 1, value: c.balance / remain });
    });
    return points;
  }, [sortedCheckins, setup, baselineDaily, totalDays]);

  const trendDelta = pulseData.length > 1 ? pulseData[pulseData.length - 1].value - pulseData[pulseData.length - 2].value : 0;
  const stats = useMemo(() => setup ? computeStats(sortedCheckins, setup.originalNetStart ?? setup.netStart, totalDays) : null, [sortedCheckins, setup, totalDays]);

  function addCommitDraft() {
    if (!commitName.trim() || !commitAmount || isNaN(Number(commitAmount)) || Number(commitAmount) <= 0) return;
    setCommitDraft([...commitDraft, { id: uid(), name: commitName.trim(), amount: Number(commitAmount) }]);
    setCommitName(''); setCommitAmount('');
  }
  function removeCommitDraft(id) { setCommitDraft(commitDraft.filter((c) => c.id !== id)); }
  function applyCalc() {
    const total = commitDraft.reduce((s, c) => s + c.amount, 0);
    const net = Number(salaryCalc) - total;
    if (net > 0) { setNetInput(String(Math.round(net))); setShowCalc(false); }
  }

  const paydayNum = Number(paydayInput);
  const canStart = nameInput.trim().length > 0 && Number(netInput) > 0 && paydayNum >= 1 && paydayNum <= 31;

  const previewCycleDays = useMemo(() => {
    if (!(paydayNum >= 1 && paydayNum <= 31)) return null;
    const cs = findCycleStart(today, paydayNum);
    const ce = addCycleMonths(cs, 1, paydayNum);
    return diffDays(cs, ce);
  }, [paydayNum]);

  async function completeSetup() {
    if (!canStart) return;
    const cs = findCycleStart(today, paydayNum);
    const newSetup = {
      name: nameInput.trim(), netStart: Number(netInput), originalNetStart: Number(netInput), paydayDom: paydayNum, cycleStart: isoDate(cs),
      commitments: commitDraft.length ? commitDraft : undefined,
      salaryUsed: commitDraft.length && salaryCalc ? Number(salaryCalc) : undefined,
    };
    setSetup(newSetup); setCheckins([]); setView('dashboard'); setSelectedDay(diffDays(cs, today));
    await persist({ setup: newSetup, checkins: [] });
    await upsertCycleRow(session.user.id, newSetup);
    setDbCycles(await fetchCyclesList(session.user.id));
  }

  function openDay(d) {
    setSelectedDay(d);
    const existing = checkins.find((c) => c.day === d);
    setEntryBalance(existing ? String(existing.rawBalance ?? existing.balance) : '');
    setEntryNote(existing ? existing.note || '' : '');
    setExtraIncomeInput(existing && existing.extraIncome ? String(existing.extraIncome) : '');
    setShowExtraIncome(!!(existing && existing.extraIncome));
  }

  async function saveEntry() {
    const typedBalance = Number(entryBalance);
    if (isNaN(typedBalance) || entryBalance === '') return;
    const extraIncome = Number(extraIncomeInput) > 0 ? Number(extraIncomeInput) : 0;
    const finalBalance = typedBalance + extraIncome;
    const existingEntry = checkins.find((c) => c.day === selectedDay);
    const prevIncome = existingEntry?.extraIncome || 0;
    const incomeDelta = extraIncome - prevIncome;
    const rest = checkins.filter((c) => c.day !== selectedDay);
    const newCheckins = [...rest, { day: selectedDay, balance: finalBalance, rawBalance: typedBalance, note: entryNote.trim(), ts: Date.now(), extraIncome: extraIncome || undefined }];
    setCheckins(newCheckins);
    setJustSaved(true); setTimeout(() => setJustSaved(false), 900);
    if (incomeDelta !== 0 && setup) {
      const newSetup = { ...setup, netStart: setup.netStart + incomeDelta };
      setSetup(newSetup);
      await persist({ setup: newSetup, checkins: newCheckins });
    } else {
      await persist({ checkins: newCheckins });
    }
    if (setup) {
      try {
        const checkinDate = new Date(cycleStartDate);
        checkinDate.setDate(checkinDate.getDate() + selectedDay);
        await supabase.from('daily_checkins').insert({
          user_id: session.user.id,
          balance: Math.round(finalBalance),
          note: entryNote.trim(),
          extra_incomen: String(extraIncome),
          cycle_start_date: setup.cycleStart,
          checkin_date: isoDate(checkinDate),
        });
      } catch (e) {}
    }
    setExtraIncomeInput(''); setShowExtraIncome(false);
  }
  async function deleteEntry() {
    const existingEntry = checkins.find((c) => c.day === selectedDay);
    if (!existingEntry) return;
    const prevIncome = existingEntry.extraIncome || 0;
    const newCheckins = checkins.filter((c) => c.day !== selectedDay);
    setCheckins(newCheckins);
    setEntryBalance(''); setEntryNote(''); setExtraIncomeInput(''); setShowExtraIncome(false);
    if (prevIncome > 0 && setup) {
      const newSetup = { ...setup, netStart: setup.netStart - prevIncome };
      setSetup(newSetup);
      await persist({ setup: newSetup, checkins: newCheckins });
    } else {
      await persist({ checkins: newCheckins });
    }
  }

  async function startNewCycle() {
    const amount = Number(newCycleInput);
    if (!amount || amount <= 0 || !setup) return;
    const cs = actualCycleStart;
    const archived = { setup, checkins };
    const newHistory = [...cycleHistory, archived];
    const newSetup = { name: setup.name, netStart: amount, originalNetStart: amount, paydayDom: setup.paydayDom, cycleStart: isoDate(cs) };
    setSetup(newSetup); setCheckins([]); setCycleHistory(newHistory); setNewCycleInput('');
    const idx = Math.max(0, diffDays(cs, today));
    setSelectedDay(idx); setEntryBalance(''); setEntryNote('');
    await persist({ setup: newSetup, checkins: [], cycleHistory: newHistory });
    await upsertCycleRow(session.user.id, newSetup);
    setDbCycles(await fetchCyclesList(session.user.id));
  }

  async function updateSetupInfo({ name, netStart, paydayDom }) {
    if (!setup) return;
    const effectivePayday = paydayDom || setup.paydayDom;
    const paydayChanged = paydayDom && paydayDom !== setup.paydayDom;
    // only recompute the cycle's start date if the payday itself changed — otherwise leave
    // the existing cycleStart untouched so we don't silently skip the "cycle rolled" archive flow
    const newCycleStart = paydayChanged ? findCycleStart(today, effectivePayday) : parseISO(setup.cycleStart);
    const newSetup = {
      ...setup,
      name: name !== undefined ? name : setup.name,
      netStart: netStart !== undefined && netStart > 0 ? netStart : setup.netStart,
      originalNetStart: netStart !== undefined && netStart > 0 ? netStart : (setup.originalNetStart ?? setup.netStart),
      paydayDom: effectivePayday,
      cycleStart: isoDate(newCycleStart),
    };
    setSetup(newSetup);
    if (paydayChanged) {
      const newTotalDays = diffDays(newCycleStart, addCycleMonths(newCycleStart, 1, effectivePayday));
      const newTodayIndex = Math.max(0, Math.min(newTotalDays - 1, diffDays(newCycleStart, today)));
      setSelectedDay(newTodayIndex);
      const existing = checkins.find((c) => c.day === newTodayIndex);
      setEntryBalance(existing ? String(existing.rawBalance ?? existing.balance) : '');
      setEntryNote(existing ? existing.note || '' : '');
      setShowExtraIncome(!!(existing && existing.extraIncome));
      setExtraIncomeInput(existing && existing.extraIncome ? String(existing.extraIncome) : '');
    }
    await persist({ setup: newSetup });
    await upsertCycleRow(session.user.id, newSetup);
    setDbCycles(await fetchCyclesList(session.user.id));
  }

  async function addBill(bill) {
    const newBills = [...bills, { id: uid(), ...bill }];
    setBills(newBills);
    await persist({ bills: newBills });
  }
  async function deleteBill(id) {
    const newBills = bills.filter((b) => b.id !== id);
    setBills(newBills);
    await persist({ bills: newBills });
  }
  async function updateBill(id, patch) {
    const newBills = bills.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBills(newBills);
    await persist({ bills: newBills });
  }

  async function addGoal(goal) {
    const newGoals = [...goals, { id: uid(), saved: 0, ...goal }];
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }
  async function updateGoalSaved(id, saved) {
    const newGoals = goals.map((g) => (g.id === id ? { ...g, saved } : g));
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }
  async function updateGoalDate(id, targetDate) {
    const newGoals = goals.map((g) => (g.id === id ? { ...g, targetDate } : g));
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }
  async function updateGoalTarget(id, target) {
    const newGoals = goals.map((g) => (g.id === id ? { ...g, target } : g));
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }
  // combined update — use this (not the single-field helpers above) whenever more than one
  // goal field changes in the same action, so the second write can't clobber the first with stale state
  async function updateGoal(id, patch) {
    const newGoals = goals.map((g) => (g.id === id ? { ...g, ...patch } : g));
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }
  async function deleteGoal(id) {
    const newGoals = goals.filter((g) => g.id !== id);
    setGoals(newGoals);
    await persist({ goals: newGoals });
  }

  async function resetAll() {
    setSetup(null); setCheckins([]); setCycleHistory([]); setBills([]); setGoals([]); setView('onboarding');
    setNetInput(''); setPaydayInput('1'); setCommitDraft([]); setShowCalc(false); setConfirmReset(false);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, setup: null, checkins: [], cycleHistory: [], bills: [], goals: [] })); } catch (e) {}
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  async function completeAccountWelcome() {
    // the phone field is validated (9 digits, starts with 5) inside AccountWelcomeView
    // before this is ever called, so digits here is always a complete, valid number
    if (session?.user?.id) {
      try {
        await supabase.from('profiles').upsert({ user_id: session.user.id, phone: '+966' + phoneInput });
      } catch (e) {}
    }
    setPhoneInput('');
    setView('welcome');
  }

  const colors = theme === 'dark' ? DARK : LIGHT;

  if (!ready) {
    return (
      <ThemeCtx.Provider value={colors}>
        <Shell><div className="flex h-full min-h-[560px] items-center justify-center"><Loader2 className="animate-spin" size={28} color={colors.muted} /></div></Shell>
      </ThemeCtx.Provider>
    );
  }

  if (!session) {
    return (
      <ThemeCtx.Provider value={colors}>
        <Shell><LoginView theme={theme} toggleTheme={toggleTheme} authError={authError} /></Shell>
      </ThemeCtx.Provider>
    );
  }

  return (
    <ThemeCtx.Provider value={colors}>
      <Shell>
        {view === 'account-welcome' && (
          <AccountWelcomeView
            phoneInput={phoneInput} setPhoneInput={setPhoneInput}
            onContinue={completeAccountWelcome}
          />
        )}
        {view === 'welcome' && (
          <Welcome onStart={() => setView('onboarding')} theme={theme} toggleTheme={toggleTheme} />
        )}
        {view === 'onboarding' && (
          <Onboarding
            nameInput={nameInput} setNameInput={setNameInput}
            netInput={netInput} setNetInput={setNetInput}
            paydayInput={paydayInput} setPaydayInput={setPaydayInput}
            previewCycleDays={previewCycleDays}
            showCalc={showCalc} setShowCalc={setShowCalc}
            salaryCalc={salaryCalc} setSalaryCalc={setSalaryCalc}
            commitDraft={commitDraft} commitName={commitName} setCommitName={setCommitName}
            commitAmount={commitAmount} setCommitAmount={setCommitAmount}
            addCommitDraft={addCommitDraft} removeCommitDraft={removeCommitDraft} applyCalc={applyCalc}
            canStart={canStart} completeSetup={completeSetup}
            theme={theme} toggleTheme={toggleTheme}
          />
        )}
        {view === 'dashboard' && setup && !cycleRolled && (
          <Dashboard
            setup={setup} dailyBudget={dailyBudget} baselineDaily={baselineDaily}
            status={status} pulseData={pulseData} trendDelta={trendDelta}
            todayIndex={todayIndex} daysRemaining={daysRemaining} totalDays={totalDays}
            effectiveBalance={effectiveBalance} checkins={checkins} sortedCheckins={sortedCheckins}
            selectedDay={selectedDay} openDay={openDay}
            entryBalance={entryBalance} setEntryBalance={setEntryBalance}
            entryNote={entryNote} setEntryNote={setEntryNote}
            showExtraIncome={showExtraIncome} setShowExtraIncome={setShowExtraIncome}
            extraIncomeInput={extraIncomeInput} setExtraIncomeInput={setExtraIncomeInput}
            saveEntry={saveEntry} deleteEntry={deleteEntry} justSaved={justSaved} stats={stats}
            cycleHistory={cycleHistory} dbCycles={dbCycles} historyLoading={historyLoading}
            bills={bills} addBill={addBill} deleteBill={deleteBill} updateBill={updateBill}
            goals={goals} addGoal={addGoal} updateGoalSaved={updateGoalSaved} updateGoalDate={updateGoalDate} updateGoalTarget={updateGoalTarget} updateGoal={updateGoal} deleteGoal={deleteGoal}
            onViewHistory={async (cycleStartIso) => {
              setHistoryLoading(true);
              const detail = await fetchCycleDetail(session.user.id, cycleStartIso);
              setHistoryLoading(false);
              if (detail) { setHistoryArchived(detail); setView('history-detail'); }
            }}
            onSettings={() => setView('settings')} theme={theme} toggleTheme={toggleTheme}
          />
        )}
        {view === 'dashboard' && setup && cycleRolled && (
          <CycleRolledView
            stats={stats} name={setup.name} baselineDaily={baselineDaily} newCycleInput={newCycleInput} setNewCycleInput={setNewCycleInput}
            startNewCycle={startNewCycle} theme={theme} toggleTheme={toggleTheme}
          />
        )}
        {view === 'settings' && setup && (
          <SettingsView setup={setup} onBack={() => setView('dashboard')} onInstallGuide={() => setView('install-guide')} onAbout={() => setView('about')} onFaq={() => setView('faq')} onGuide={() => setView('guide')} onUpdateSetup={updateSetupInfo} confirmReset={confirmReset} setConfirmReset={setConfirmReset} resetAll={resetAll} onLogout={handleLogout} />
        )}
        {view === 'install-guide' && (
          <InstallGuideView onBack={() => setView('settings')} theme={theme} toggleTheme={toggleTheme} />
        )}
        {view === 'about' && (
          <AboutView onBack={() => setView('settings')} theme={theme} toggleTheme={toggleTheme} />
        )}
        {view === 'faq' && (
          <FaqView onBack={() => setView('settings')} theme={theme} toggleTheme={toggleTheme} />
        )}
        {view === 'guide' && (
          <GuideView onBack={() => setView('settings')} theme={theme} toggleTheme={toggleTheme} />
        )}
        {view === 'history-detail' && historyArchived && (
          <HistoryDetailView
            archived={historyArchived}
            onBack={() => setView('dashboard')} theme={theme} toggleTheme={toggleTheme}
          />
        )}
      </Shell>
    </ThemeCtx.Provider>
  );
}

function Shell({ children }) {
  const colors = useColors();
  return (
    <div dir="rtl" lang="ar" style={{ background: colors.ink, minHeight: '100vh', transition: 'background 0.3s' }} className="flex justify-center px-4 py-8">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@500;700;800;900&family=Tajawal:wght@400;500;700&display=swap');
        * { font-family: 'Tajawal', sans-serif; }
        .display { font-family: 'Cairo', sans-serif; }
        .num { font-family: 'Cairo', sans-serif; font-variant-numeric: tabular-nums; }
        .daystrip::-webkit-scrollbar { display: none; }
        .daystrip { scrollbar-width: none; -ms-overflow-style: none; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: rgba(150,150,150,0.25); border-radius: 8px; }
        input:focus { outline: none; }
        @keyframes dotpulse { 0% { transform: scale(1); opacity: 1; } 70% { transform: scale(2.4); opacity: 0; } 100% { transform: scale(2.4); opacity: 0; } }
        @keyframes floatIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .float-in { animation: floatIn 0.35s ease both; }
        @media (prefers-reduced-motion: reduce) { .float-in { animation: none; } }
      `}</style>
      <div className="w-full max-w-[420px]">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  const colors = useColors();
  return <div className="flex flex-col gap-1.5"><span style={{ color: colors.muted }} className="text-[13px]">{label}</span>{children}</div>;
}

function ThemeToggle({ theme, toggleTheme }) {
  const colors = useColors();
  return (
    <button onClick={toggleTheme} aria-label="تبديل الوضع الليلي والنهاري" style={{ background: colors.surface, color: colors.paper }} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0">
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function AccountWelcomeView({ phoneInput, setPhoneInput, onContinue }) {
  const colors = useColors();
  const [phoneError, setPhoneError] = useState('');
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };

  function handleContinue() {
    if (!/^5\d{8}$/.test(phoneInput)) {
      setPhoneError('أدخل رقم جوال صحيح — 9 أرقام تبدأ بـ5');
      return;
    }
    setPhoneError('');
    onContinue();
  }

  return (
    <div className="float-in min-h-[75vh] flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-2">
        <div style={{ background: colors.good }} className="w-16 h-16 rounded-full flex items-center justify-center mb-6">
          <Check size={30} color={colors.ink} />
        </div>

        <h1 className="display text-[24px] font-black leading-tight" style={{ color: colors.paper }}>
          أهلًا فيك
        </h1>
        <p className="text-[14.5px] mt-4 leading-relaxed" style={{ color: colors.muted }}>
          حسابك جاهز، وبياناتك محفوظة بأمان. يلا نبدأ نرتب راتبك
        </p>

        <div className="w-full mt-8 pt-6" style={{ borderTop: `1px solid ${colors.line}` }}>
          <span className="text-[12.5px] block mb-1.5 text-right" style={{ color: colors.muted }}>أدخل رقمك</span>
          <div dir="ltr" className="flex items-stretch rounded-xl overflow-hidden" style={inputStyle}>
            <span className="px-3 flex items-center text-[14.5px] font-bold shrink-0" style={{ color: colors.muted, borderRight: `1px solid ${colors.line}` }}>+966</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={9}
              placeholder="5xxxxxxxx"
              value={phoneInput}
              onChange={(e) => { setPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 9)); setPhoneError(''); }}
              className="flex-1 px-3 py-2.5 text-[15px] num bg-transparent"
              style={{ color: colors.paper }}
            />
          </div>
          {phoneError && (
            <p className="text-[12.5px] mt-2 text-right" style={{ color: colors.bad }}>{phoneError}</p>
          )}
        </div>
      </div>

      <button
        onClick={handleContinue}
        style={{ background: colors.warn, color: colors.ink }}
        className="w-full rounded-2xl py-4 font-bold text-[16px] display flex items-center justify-center gap-2 mt-6"
      >
        البداية
      </button>
    </div>
  );
}

function LoginView({ theme, toggleTheme, authError }) {
  const colors = useColors();
  async function loginWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/' },
    });
  }
  return (
    <div className="float-in min-h-[75vh] flex flex-col">
      <div className="flex items-center justify-end mb-6">
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center px-2">
        <div style={{ background: colors.warn }} className="w-16 h-16 rounded-full flex items-center justify-center mb-6">
          <Wallet size={28} color={colors.ink} />
        </div>

        <h1 className="display text-[24px] font-black leading-tight" style={{ color: colors.paper }}>
          سجّل دخولك عشان نبدأ
        </h1>
        <p className="text-[14.5px] mt-4 leading-relaxed" style={{ color: colors.muted }}>
          بياناتك ترتبط بحسابك، وتقدر ترجع لها من أي جهاز تسجّل دخول منه.
        </p>
        {authError && (
          <p className="text-[13px] mt-4 leading-relaxed" style={{ color: colors.bad }}>
            تعذّر تسجيل الدخول: {authError}
          </p>
        )}
      </div>

      <button
        onClick={loginWithGoogle}
        style={{ background: colors.warn, color: colors.ink }}
        className="w-full rounded-2xl py-4 font-bold text-[16px] display flex items-center justify-center gap-2 mt-6"
      >
        سجّل دخول بجوجل
      </button>
    </div>
  );
}

function Welcome({ onStart, theme, toggleTheme }) {
  const colors = useColors();
  return (
    <div className="float-in min-h-[75vh] flex flex-col">
      <div className="flex items-center justify-end mb-6">
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center px-2">
        <div style={{ background: colors.warn }} className="w-16 h-16 rounded-full flex items-center justify-center mb-6">
          <Wallet size={28} color={colors.ink} />
        </div>

        <h1 className="display text-[28px] font-black leading-tight" style={{ color: colors.paper }}>
          أنت على وشك شي<br />بيغيّر وضعك المادي
        </h1>
        <p className="text-[14.5px] mt-4 leading-relaxed" style={{ color: colors.muted }}>
          مو سحر، ومو حرمان من كل شي — بس نظام بسيط يخليك تعرف بالضبط كم تقدر تصرف كل يوم، بدون ما تشيل هم آخر الشهر.
        </p>
        <p className="text-[14.5px] mt-3 leading-relaxed font-bold" style={{ color: colors.good }}>
          لو بادرت والتزمت من الحين، بعد ٣٠ يوم بس راح تحس بالفرق.
        </p>
      </div>

      <button
        onClick={onStart}
        style={{ background: colors.warn, color: colors.ink }}
        className="w-full rounded-2xl py-4 font-bold text-[16px] display flex items-center justify-center gap-2 mt-6"
      >
        ابدأ هنا
        <ChevronLeft size={18} />
      </button>
    </div>
  );
}

function InstallGuideView({ onBack, theme, toggleTheme }) {
  const colors = useColors();
  const [tab, setTab] = useState('ios'); // 'ios' | 'android'

  const iosSteps = [
    <>افتح الموقع من متصفح <b>Safari</b> (لازم يكون Safari بالذات، مو كروم)</>,
    <>اضغط زر <b>المشاركة</b> (المربع اللي فيه سهم لفوق) بأسفل الشاشة</>,
    <>مرّر لين تلقى <b>"إضافة إلى الشاشة الرئيسية"</b> واضغط عليها</>,
    <>اضغط <b>"إضافة"</b> فوق يمين الشاشة — خلاص، الأيقونة صارت بجوالك</>,
  ];
  const androidSteps = [
    <>افتح الموقع من متصفح <b>Chrome</b></>,
    <>راح يطلع لك تلقائي بانر أو زر <b>"تثبيت التطبيق"</b> — اضغط عليه</>,
    <>إذا ما طلع تلقائي: اضغط النقاط الثلاث ⋮ فوق يمين المتصفح ← <b>"تثبيت التطبيق"</b></>,
  ];
  const steps = tab === 'ios' ? iosSteps : androidSteps;

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <h1 className="display text-[20px] font-black" style={{ color: colors.paper }}>ثبّت التطبيق على جوالك</h1>
      <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: colors.muted }}>يفتح بضغطة وحدة زي أي تطبيق، بدون متصفح</p>

      <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-5">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('ios')}
            style={{ background: tab === 'ios' ? colors.warn : colors.surface2, color: tab === 'ios' ? colors.ink : colors.muted }}
            className="flex-1 rounded-xl py-2.5 text-[13px] font-bold"
          >📱 آيفون</button>
          <button
            onClick={() => setTab('android')}
            style={{ background: tab === 'android' ? colors.warn : colors.surface2, color: tab === 'android' ? colors.ink : colors.muted }}
            className="flex-1 rounded-xl py-2.5 text-[13px] font-bold"
          >🤖 أندرويد</button>
        </div>

        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3 mb-4 last:mb-0">
            <span style={{ background: colors.surface2, color: colors.paper }} className="w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0">{i + 1}</span>
            <span className="text-[13.5px] leading-relaxed" style={{ color: colors.paper }}>{step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dot({ n, top, right, left }) {
  const colors = useColors();
  return (
    <span
      style={{ position: 'absolute', top, right, left, background: colors.warn, color: colors.ink, width: 22, height: 22, borderRadius: 99, fontSize: 11, fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 3px rgba(0,0,0,0.4)' }}
      className="num"
    >
      {n}
    </span>
  );
}

function LegendRow({ n, text }) {
  const colors = useColors();
  return (
    <div className="flex items-start gap-2.5">
      <span style={{ background: colors.warn, color: colors.ink, width: 20, height: 20, borderRadius: 99, fontSize: 10.5, flexShrink: 0, marginTop: 1 }} className="num font-bold flex items-center justify-center">{n}</span>
      <span className="text-[12.5px] leading-relaxed" style={{ color: colors.paper }}>{text}</span>
    </div>
  );
}

function GuideSection({ title, children, legend }) {
  const colors = useColors();
  return (
    <div className="mb-6">
      <h3 className="display text-[15px] font-bold mb-2.5" style={{ color: colors.paper }}>{title}</h3>
      <div style={{ background: colors.surface }} className="rounded-2xl p-4 relative">
        {children}
      </div>
      <div className="flex flex-col gap-2 mt-3 px-1">
        {legend.map((l, i) => <LegendRow key={i} n={i + 1} text={l} />)}
      </div>
    </div>
  );
}

function GuideView({ onBack, theme, toggleTheme }) {
  const colors = useColors();
  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>
      <h1 className="display text-[22px] font-black mb-1.5" style={{ color: colors.paper }}>دليل استخدام التطبيق</h1>
      <p className="text-[13px] mb-6 leading-relaxed" style={{ color: colors.muted }}>كل خانة بالتطبيق موضّحة هنا برقم صغير - تعرف كل شي بدون ما حد يشرح لك</p>

      <GuideSection
        title="مشوارك كامل"
        legend={[
          'تظهر بأعلى الشاشة الرئيسية بعد ما تكمّل أول دورة كاملة (مو من أول استخدام)',
          'عدد الشهور اللي سجّلت فيها، ومتوسط التزامك العام، وأفضل شهر حققته',
        ]}
      >
        <div className="relative grid grid-cols-3 gap-2">
          {[{ v: '4', l: 'شهر' }, { v: '78%', l: 'متوسط التزامك' }, { v: '92%', l: 'أفضل شهر لك' }].map((it, i) => (
            <div key={i} className="text-center">
              <div className="num text-[16px] font-extrabold display" style={{ color: colors.paper }}>{it.v}</div>
              <div className="text-[9px] mt-0.5" style={{ color: colors.muted }}>{it.l}</div>
            </div>
          ))}
          <Dot n={1} top={-10} right={-6} />
        </div>
      </GuideSection>

      <GuideSection
        title="البطاقة الرئيسية"
        legend={[
          'شارة حالتك الحالية - أخضر ممتاز، أصفر انتبه، أحمر تجاوزت',
          'حدّك اليومي - كم تقدر تصرف اليوم بالضبط',
          'خط يبيّن مسار متوسطك اليومي، يرتفع إذا وفّرت وينخفض إذا تجاوزت',
          'مقارنة سريعة: أمس، اليوم، والفرق بينهم',
        ]}
      >
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: colors.muted }}>حدّك اليومي</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full relative" style={{ background: colors.surface2, color: colors.good }}>ممتاز<Dot n={1} top={-14} right={-10} /></span>
          </div>
          <div className="relative flex items-end gap-1.5 mt-1.5">
            <span className="num display font-black" style={{ fontSize: 34, color: colors.good }}>538</span>
            <span className="text-[11px] mb-1" style={{ color: colors.muted }}>ر.س/اليوم</span>
            <Dot n={2} top={0} right={90} />
          </div>
          <div className="relative mt-2" style={{ height: 30 }}>
            <svg width="100%" height="30" viewBox="0 0 200 30" preserveAspectRatio="none">
              <polyline points="0,10 40,14 80,8 120,18 160,12 200,20" fill="none" stroke={colors.good} strokeWidth="2" />
            </svg>
            <Dot n={3} top={-4} right={4} />
          </div>
          <div className="relative flex justify-between mt-2.5 pt-2" style={{ borderTop: `1px solid ${colors.line}` }}>
            <span className="text-[10px]" style={{ color: colors.muted }}>أمس</span>
            <span className="text-[10px]" style={{ color: colors.muted }}>اليوم</span>
            <span className="text-[10px]" style={{ color: colors.muted }}>التغيير</span>
            <Dot n={4} top={-10} right={80} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="توقع نهاية الدورة"
        legend={['يحسب لك تلقائيًا: لو كمّلت بنفس معدلك الحالي، بتوفر أو بتحتاج كم آخر الدورة']}
      >
        <div className="relative" style={{ borderRight: `3px solid ${colors.good}` }}>
          <span className="text-[11.5px] px-2" style={{ color: colors.paper }}>لو صرفت بنفس معدلك، بتوفر <b style={{ color: colors.good }}>800</b> ر.س آخر الدورة</span>
          <Dot n={1} top={-10} right={-6} />
        </div>
      </GuideSection>

      <GuideSection
        title="الملخصات السريعة"
        legend={[
          'المبلغ الأساسي - كم كان معك أول الدورة، والمبلغ المتبقي - كم باقي لك الحين',
          'إجمالي الاستهلاك - كم صرفت لين الحين، وأيام متبقية - كم باقي على نهاية الدورة',
        ]}
      >
        <div className="relative grid grid-cols-2 gap-2">
          <div className="relative flex" style={{ background: colors.surface2, borderRadius: 12 }}>
            <div className="px-2.5 py-2 flex-1"><div className="text-[9px]" style={{ color: colors.muted }}>المبلغ الأساسي</div><div className="num text-[12px] font-bold" style={{ color: colors.paper }}>6,000</div></div>
            <div style={{ width: 1, background: colors.line }} />
            <div className="px-2.5 py-2 flex-1"><div className="text-[9px]" style={{ color: colors.muted }}>المبلغ المتبقي</div><div className="num text-[12px] font-bold" style={{ color: colors.paper }}>2,810</div></div>
            <Dot n={1} top={-8} right={-6} />
          </div>
          <div className="relative flex" style={{ background: colors.surface2, borderRadius: 12 }}>
            <div className="px-2.5 py-2 flex-1"><div className="text-[9px]" style={{ color: colors.muted }}>الاستهلاك</div><div className="num text-[12px] font-bold" style={{ color: colors.paper }}>3,190</div></div>
            <div style={{ width: 1, background: colors.line }} />
            <div className="px-2.5 py-2 flex-1"><div className="text-[9px]" style={{ color: colors.muted }}>أيام متبقية</div><div className="num text-[12px] font-bold" style={{ color: colors.paper }}>14</div></div>
            <Dot n={2} top={-8} right={-6} />
          </div>
        </div>
      </GuideSection>


      <GuideSection
        title="شريط الأيام"
        legend={[
          'يوم فاضي - ما سجلت فيه رصيدك، أو لسه ما جاء',
          'اليوم الحالي - عليه إطار أصفر بارز',
        ]}
      >
        <div className="relative flex gap-2">
          <div className="relative">
            <div style={{ background: colors.good, color: colors.ink }} className="rounded-lg px-3 py-2 text-[11px] font-bold">يوم 1</div>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative">
            <div style={{ background: 'transparent', border: `1.5px solid ${colors.line}`, color: colors.muted }} className="rounded-lg px-3 py-2 text-[11px] font-bold">يوم 2</div>
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative">
            <div style={{ background: colors.surface2, border: `1.5px solid ${colors.warn}`, color: colors.paper }} className="rounded-lg px-3 py-2 text-[11px] font-bold">يوم 3</div>
            <Dot n={3} top={-10} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="تسجيل رصيدك اليومي"
        legend={[
          'حط هنا كم باقي بحسابك بالضبط',
          'ملاحظة اختيارية عن يومك',
          'زر الحفظ',
          'رابط "دخل إضافي" - يضيفه تلقائيًا فوق رصيدك، ما تحتاج تحسبه بنفسك',
          'لو تسجيل اليوم غلط، رابط "حذف تسجيل هذا اليوم" يمسحه بالكامل ويرجّعه فاضي',
        ]}
      >
        <div className="relative flex gap-2 items-center flex-wrap">
          <div className="relative">
            <div style={{ background: colors.surface2, color: colors.paper }} className="rounded-lg px-3 py-2 text-[12px] w-16 text-center">0</div>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative flex-1 min-w-[70px]">
            <div style={{ background: colors.surface2, color: colors.muted }} className="rounded-lg px-3 py-2 text-[11px]">ملاحظة</div>
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative">
            <div style={{ background: colors.warn, color: colors.ink }} className="rounded-lg w-9 h-9 flex items-center justify-center">✓</div>
            <Dot n={3} top={-10} right={-6} />
          </div>
          <div className="relative w-full mt-1">
            <span className="text-[11px] font-bold" style={{ color: colors.good }}>+ جاك دخل إضافي اليوم؟</span>
            <Dot n={4} top={-12} right={-6} />
          </div>
          <div className="relative w-full">
            <span className="text-[10.5px] font-bold" style={{ color: colors.bad }}>حذف تسجيل هذا اليوم</span>
            <Dot n={5} top={-10} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="إحصائياتك"
        legend={[
          'نسبة الأيام اللي التزمت فيها بحدّك',
          'كم يوم متتالي أنت ملتزم فيه الحين',
          'أطول سلسلة التزام حققتها بالدورة',
          'متوسط صرفك اليومي الفعلي',
          'أفضل يوم صرفت فيه أقل شي',
          'أسوأ يوم صرفت فيه أكثر شي',
        ]}
      >
        <div className="relative grid grid-cols-2 gap-2">
          {['نسبة الالتزام', 'السلسلة الحالية', 'أطول سلسلة', 'متوسط الصرف', 'أفضل يوم', 'أسوأ يوم'].map((t, i) => (
            <div key={i} className="relative" style={{ background: colors.surface2 }}>
              <div className="rounded-lg px-2 py-2.5 text-[10px] text-center" style={{ color: colors.muted }}>{t}</div>
              <Dot n={i + 1} top={-8} right={-6} />
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection
        title="الشارتات"
        legend={[
          'دائرة نسبة التزامك - أخضر لملتزم، أحمر لمتجاوز',
          'عمود لكل يوم يبيّن صرفك فيه',
          'خط يقارن مسارك الفعلي بالمسار المثالي المفترض',
        ]}
      >
        <div className="relative flex flex-col gap-3">
          <div className="relative flex items-center gap-2">
            <div style={{ width: 36, height: 36, borderRadius: 99, border: `6px solid ${colors.good}`, borderLeftColor: colors.bad }} />
            <span className="text-[11px]" style={{ color: colors.muted }}>نسبة التزامك</span>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative flex items-end gap-1" style={{ height: 28 }}>
            {[14, 22, 10, 26, 8].map((h, i) => (<div key={i} style={{ width: 10, height: h, background: i % 2 ? colors.bad : colors.good, borderRadius: 3 }} />))}
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative" style={{ height: 22 }}>
            <svg width="100%" height="22" viewBox="0 0 200 22" preserveAspectRatio="none">
              <line x1="0" y1="4" x2="200" y2="18" stroke={colors.muted} strokeDasharray="4 4" strokeWidth="1.5" />
              <polyline points="0,4 50,10 100,8 150,14 200,10" fill="none" stroke={colors.warn} strokeWidth="2" />
            </svg>
            <Dot n={3} top={-6} right={4} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="بطاقات تحليلية إضافية"
        legend={[
          'نمط أيام الأسبوع - تظهر بعد ما يكون عندك ٣ أيام مسجّلة على الأقل، توضح في أي يوم بالأسبوع تصرف أكثر عادة ومتوسط صرفك فيه',
          'تطور التزامك عبر الشهور - تظهر بعد أول دورة كاملة، عمود لكل دورة سابقة يقارن نسبة التزامك شهر بشهر',
        ]}
      >
        <div className="relative flex flex-col gap-3">
          <div className="relative" style={{ paddingTop: 4 }}>
            <span className="text-[11px]" style={{ color: colors.muted }}>تصرف أكثر أيام <b style={{ color: colors.warn }}>الخميس</b> - متوسط 240 ر.س</span>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative flex items-end gap-1.5" style={{ height: 26, borderTop: `1px solid ${colors.line}`, paddingTop: 8 }}>
            {[16, 24, 12, 26].map((h, i) => (<div key={i} style={{ width: 14, height: h, background: colors.warn, borderRadius: 3 }} />))}
            <Dot n={2} top={-6} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="مشاركة إنجازك"
        legend={[
          'زر "شارك إنجازك" بأسفل بطاقة الإحصائيات - يرسم لك بطاقة صورة كاملة',
          'كل الأرقام فيها نسب مئوية بس (مو مبالغ بالريال) - عشان تقدر تشاركها بارتياح بدون ما تكشف أرقامك المالية',
          'بعد ما تتولّد، زر "تنزيل الصورة" يحفظها على جهازك عشان تحطها بالستوري',
        ]}
      >
        <div className="relative flex flex-col items-center gap-2">
          <div style={{ background: colors.surface2, color: colors.paper }} className="rounded-xl px-4 py-2.5 text-[12px] font-bold flex items-center gap-1.5 w-full justify-center">
            📤 شارك إنجازك
          </div>
          <Dot n={1} top={-10} right={-6} />
          <div className="relative w-full grid grid-cols-2 gap-1.5">
            {['5 يوم', '82%', '9 يوم', '58%'].map((v, i) => (
              <div key={i} style={{ background: colors.surface2 }} className="rounded-lg py-1.5 text-center num text-[11px] font-bold">{v}</div>
            ))}
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative w-full">
            <div style={{ background: colors.warn, color: colors.ink }} className="rounded-lg py-2 text-[11px] font-bold text-center w-full">تنزيل الصورة 📥</div>
            <Dot n={3} top={-10} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="التزاماتي"
        legend={[
          'إجمالي كل التزاماتك مجموعة - ثابت بمكانه دايمًا فوق يمين البطاقة',
          'تسجّل هنا فواتيرك وأقساطك الشهرية (اسم، مبلغ، يوم الاستحقاق) كتذكير بس - ما تؤثر على حساب حدّك اليومي',
          'كل التزام يوضح لك كم يوم متبقي على استحقاقه، وتقدر تعدّله بضغطة القلم في أي وقت',
        ]}
      >
        <div className="relative flex flex-col gap-2">
          <div className="relative flex justify-end">
            <div style={{ background: colors.surface2 }} className="rounded-lg px-2.5 py-1.5 text-left">
              <div className="text-[8px]" style={{ color: colors.muted }}>الإجمالي</div>
              <div className="num text-[11px] font-extrabold" style={{ color: colors.paper }}>1,549 <span className="text-[8px] font-normal" style={{ color: colors.muted }}>ر.س</span></div>
            </div>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative flex gap-2">
            <div className="relative" style={{ background: colors.surface2, minWidth: 100 }}>
              <div className="rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-[10.5px] font-bold" style={{ color: colors.paper }}>قسط السيارة</div>
                  <Pencil size={11} color={colors.muted} />
                </div>
                <div className="text-[9px] mt-1" style={{ color: colors.muted }}>يوم 5 كل شهر</div>
              </div>
              <Dot n={2} top={-10} right={-6} />
            </div>
            <div className="relative" style={{ background: colors.surface2, minWidth: 100 }}>
              <div className="rounded-lg p-2.5">
                <div className="num text-[13px] font-extrabold" style={{ color: colors.paper }}>1,200 <span className="text-[9px] font-normal" style={{ color: colors.muted }}>ر.س</span></div>
              </div>
              <Dot n={3} top={-10} right={-6} />
            </div>
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="أهدافك الادخارية"
        legend={[
          'تحدد هدف ادخاري (زي عمرة أو سداد بطاقة) بمبلغ مستهدف',
          'زر "عدّل هدفك" يفتح لك خانتين: كم وفّرت وكم المبلغ المستهدف - تقدر تعدّل الاثنين مع بعض بأي وقت',
          'شريط تقدم يوضح كم وصلت من هدفك، ورسالة تحفيزية تتغيّر حسب نسبة اقترابك',
          'تاريخ مستهدف اختياري - يحسب لك تلقائيًا كم تحتاج توفر بالشهر أو الأسبوع عشان توصل بالوقت',
          'لو تجاوزت التاريخ ولسه ما وصلت، يطلع لك تذكير هادئ مع خيار تمديد التاريخ',
        ]}
      >
        <div className="relative flex flex-col gap-2">
          <div className="relative flex items-center justify-between">
            <span className="text-[11.5px] font-bold" style={{ color: colors.paper }}>عمرة</span>
            <Dot n={1} top={-10} right={30} />
          </div>
          <div className="relative" style={{ background: colors.surface2, height: 9, borderRadius: 99 }}>
            <div style={{ width: '40%', background: colors.warn, height: '100%', borderRadius: 99 }} />
          </div>
          <div className="relative flex items-center justify-between">
            <span className="text-[10.5px]" style={{ color: colors.muted }}>1,200 / 3,000 ر.س</span>
            <span className="text-[10.5px] font-bold" style={{ color: colors.warn }}>عدّل هدفك</span>
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative">
            <span className="text-[10.5px]" style={{ color: colors.muted }}>💪 بداية موفقة! كل ريال تسدده يقربك من هدفك</span>
            <Dot n={3} top={-10} right={-6} />
          </div>
          <div className="relative flex items-center justify-between" style={{ borderTop: `1px solid ${colors.line}`, paddingTop: 6 }}>
            <span className="text-[10px]" style={{ color: colors.muted }}>تحتاج <b style={{ color: colors.paper }}>~200 ر.س/شهر</b></span>
            <Dot n={4} top={-6} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="دوراتك بالسنة"
        legend={[
          'شهر خلصته وفيه بيانات مسجّلة - تضغط عليه يفتح لك تقريره الكامل (نفس الإحصائيات والشارتات، بس لبيانات ذاك الشهر)',
          'الشهر الحالي - عليه إطار أصفر بارز، هذا اللي تشتغل فيه الحين',
          'شهر جاي لسه ما وصل - مقفول برمز 🔒 لين يجي وقته',
        ]}
      >
        <div className="relative flex gap-2">
          <div className="relative">
            <div style={{ background: colors.good, color: colors.ink }} className="rounded-lg px-3 py-2 text-[11px] font-bold text-center">شهر<br />3</div>
            <Dot n={1} top={-10} right={-6} />
          </div>
          <div className="relative">
            <div style={{ background: colors.surface2, border: `1.5px solid ${colors.warn}`, color: colors.paper }} className="rounded-lg px-3 py-2 text-[11px] font-bold text-center">شهر<br />5</div>
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative">
            <div style={{ background: 'transparent', border: `1.5px solid ${colors.line}`, color: colors.muted, opacity: 0.6 }} className="rounded-lg px-3 py-2 text-[11px] font-bold text-center">شهر<br />6</div>
            <Dot n={3} top={-10} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="لما تنتهي دورتك"
        legend={[
          'أول ما ينزل راتبك الجديد ويتجاوز تاريخ نهاية دورتك، يطلع لك ملخص أداء الدورة اللي خلصت تلقائيًا',
          'تشوف نسبة التزامك وإحصائياتك كاملة قبل ما تبدأ الدورة الجديدة',
          'تدخل مبلغك الجديد وتضغط "ابدأ الدورة الجديدة" - دورتك القديمة تُحفظ بالأرشيف ولا تُمسح',
        ]}
      >
        <div className="relative flex flex-col gap-2 items-center text-center">
          <span className="text-[12px] font-bold" style={{ color: colors.paper }}>خلصت دورتك يا خالد 👏</span>
          <div className="relative num text-[28px] font-black" style={{ color: colors.good }}>82%<Dot n={1} top={-10} right={-20} /></div>
          <div className="relative w-full" style={{ background: colors.surface2, borderRadius: 12, padding: 10 }}>
            <span className="text-[11px]" style={{ color: colors.muted }}>كم راتبك الجديد؟</span>
            <Dot n={2} top={-10} right={-6} />
          </div>
          <div className="relative w-full" style={{ background: colors.warn, color: colors.ink, borderRadius: 12, padding: 8, fontWeight: 700, fontSize: 12 }}>
            ابدأ الدورة الجديدة
            <Dot n={3} top={-10} right={-6} />
          </div>
        </div>
      </GuideSection>

      <GuideSection
        title="الإعدادات"
        legend={[
          'بياناتك الأساسية (المبلغ، يوم الراتب، اسمك)',
          'ثبّت التطبيق على جوالك',
          'من نحن',
          'الأسئلة الشائعة',
          'دليل استخدام التطبيق (هذي الصفحة اللي تقرأها الحين)',
          'تواصل مع فريق الدعم - يفتح لك إيميل جاهز ترسل عليه أي استفسار',
          'بدء دورة جديدة من الصفر (يمسح كل بياناتك الحالية)',
        ]}
      >
        <div className="relative flex flex-col gap-2">
          {['بياناتك الأساسية', 'ثبّت التطبيق', 'من نحن', 'الأسئلة الشائعة', 'دليل استخدام التطبيق', 'تواصل مع فريق الدعم', 'بدء من جديد'].map((t, i) => (
            <div key={i} className="relative">
              <div style={{ background: colors.surface2, color: i === 6 ? colors.bad : colors.paper }} className="rounded-lg px-3 py-2 text-[11px]">{t}</div>
              <Dot n={i + 1} top={-8} right={-6} />
            </div>
          ))}
        </div>
      </GuideSection>
    </div>
  );
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function daysUntilNextOccurrence(today, dueDay) {
  const y = today.getFullYear(), m = today.getMonth();
  const thisMonth = dateAtDom(y, m, dueDay);
  if (thisMonth.getTime() >= today.getTime()) return diffDays(today, thisMonth);
  const nextMonth = addCycleMonths(thisMonth, 1, dueDay);
  return diffDays(today, nextMonth);
}

function BillsSection({ bills, addBill, deleteBill, updateBill, paydayDom }) {
  const colors = useColors();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDay, setDueDay] = useState(paydayDom ? String(paydayDom) : '1');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDueDay, setEditDueDay] = useState('1');
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };
  const today = startOfDay(new Date());

  function submit() {
    const amt = Number(amount), dd = Number(dueDay);
    if (!name.trim() || !(amt > 0) || !(dd >= 1 && dd <= 31)) return;
    addBill({ name: name.trim(), amount: amt, dueDay: dd });
    setName(''); setAmount(''); setDueDay(paydayDom ? String(paydayDom) : '1'); setShowAdd(false);
  }
  function openEdit(b) {
    setEditingId(b.id); setEditName(b.name); setEditAmount(String(b.amount)); setEditDueDay(String(b.dueDay));
  }
  function saveEdit() {
    const amt = Number(editAmount), dd = Number(editDueDay);
    if (!editName.trim() || !(amt > 0) || !(dd >= 1 && dd <= 31)) return;
    updateBill(editingId, { name: editName.trim(), amount: amt, dueDay: dd });
    setEditingId(null);
  }

  return (
    <div className="mt-4">
      <div style={{ background: colors.surface }} className="rounded-2xl p-4">
        <div className="flex items-center gap-2.5 mb-1.5">
          <div style={{ background: colors.surface2 }} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[15px]">📋</div>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-[12.5px] font-bold" style={{ color: colors.paper }}>التزاماتي</span>
            <span className="text-[10.5px]" style={{ color: colors.muted }}>كل ما قلّلتها أو ألغيت وحدة منها، ارتحت أكثر</span>
          </div>
          {bills.length > 0 && (
            <div className="shrink-0 text-left" style={{ background: colors.surface2, borderRadius: 12, padding: '6px 10px' }}>
              <div className="text-[9px]" style={{ color: colors.muted }}>الإجمالي</div>
              <div className="num text-[13px] font-extrabold" style={{ color: colors.paper }}>{fmt(bills.reduce((s, b) => s + b.amount, 0))} <span className="text-[9px] font-normal" style={{ color: colors.muted }}>ر.س</span></div>
            </div>
          )}
        </div>
        <span className="text-[10px] block mb-3" style={{ color: colors.muted, opacity: 0.75, marginRight: 42 }}>💡 معلومات للتذكير بس - ما تأثر على حدّك اليومي</span>

        {bills.length === 0 && !showAdd ? (
          <div style={{ background: colors.surface2 }} className="rounded-2xl p-4 text-center">
            <span className="text-[13px]" style={{ color: colors.muted }}>ما سجّلت أي التزام لسه</span>
          </div>
        ) : (
          <div className="daystrip flex gap-2.5 overflow-x-auto pb-1" style={{ scrollSnapType: 'x proximity' }}>
            {bills.map((b) => {
              const remaining = daysUntilNextOccurrence(today, b.dueDay);
              if (editingId === b.id) {
                return (
                  <div key={b.id} style={{ background: colors.surface2, minWidth: 190, scrollSnapAlign: 'center' }} className="rounded-2xl p-3.5 shrink-0 flex flex-col gap-2">
                    <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[12.5px]" />
                    <input type="number" inputMode="decimal" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[12.5px] num" />
                    <input type="number" inputMode="numeric" min="1" max="31" value={editDueDay} onChange={(e) => setEditDueDay(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[12.5px] num" />
                    <div className="flex gap-2">
                      <button onClick={saveEdit} className="flex-1 rounded-lg py-1.5 text-[12px] font-bold" style={{ background: colors.warn, color: colors.ink }}>حفظ</button>
                      <button onClick={() => setEditingId(null)} className="flex-1 rounded-lg py-1.5 text-[12px]" style={{ background: colors.surface, color: colors.paper }}>إلغاء</button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={b.id} style={{ background: colors.surface2, minWidth: 168, scrollSnapAlign: 'center' }} className="rounded-2xl p-4 shrink-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-bold truncate" style={{ color: colors.paper }}>{b.name}</div>
                      <div className="text-[10.5px] mt-0.5" style={{ color: colors.muted }}>يوم {b.dueDay} كل شهر</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => openEdit(b)} aria-label="تعديل"><Pencil size={13} color={colors.muted} /></button>
                      <button onClick={() => deleteBill(b.id)} aria-label="حذف"><X size={14} color={colors.muted} /></button>
                    </div>
                  </div>
                  <div className="num text-[17px] font-extrabold display mt-3" style={{ color: colors.paper }}>{fmt(b.amount)} <span className="text-[11px] font-normal" style={{ color: colors.muted }}>ر.س</span></div>
                  <div className="text-[11px] font-bold mt-1" style={{ color: remaining <= 3 ? colors.bad : colors.muted }}>متبقي {remaining} يوم</div>
                </div>
              );
            })}
          </div>
        )}

        {showAdd ? (
          <div style={{ background: colors.surface2 }} className="rounded-2xl p-4 mt-3 flex flex-col gap-3">
            <Field label="اسم الالتزام">
              <input type="text" placeholder="مثال: قسط السيارة" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px]" />
            </Field>
            <Field label="المبلغ">
              <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
            </Field>
            <Field label="يوم الاستحقاق كل شهر">
              <input type="number" inputMode="numeric" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
            </Field>
            <div className="flex gap-2">
              <button onClick={submit} className="flex-1 rounded-xl py-2.5 text-[13.5px] font-bold" style={{ background: colors.warn, color: colors.ink }}>إضافة</button>
              <button onClick={() => setShowAdd(false)} className="flex-1 rounded-xl py-2.5 text-[13.5px]" style={{ background: colors.surface2, color: colors.paper }}>إلغاء</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAdd(true)} className="w-full rounded-2xl py-3 mt-3 font-bold text-[13.5px]" style={{ background: colors.surface2, color: colors.warn }}>+ أضف التزام جديد</button>
        )}
      </div>
    </div>
  );
}

function goalMotivation(pct, name) {
  if (pct <= 0) return `🌱 بدأت رحلتك نحو ${name} - أول ريال تسدده يفرق`;
  if (pct < 50) return '💪 بداية موفقة! كل ريال تسدده يقربك من هدفك';
  if (pct < 70) return '🔥 نص الطريق تمام! كمّل بنفس الحماس';
  if (pct < 100) return '⚡ قربت تخلص! باقي شوي بس وتوصل';
  return '🎉 مبروك! حققت هدفك بالكامل';
}

function goalPaceText(remaining, daysLeft) {
  if (remaining <= 0 || daysLeft <= 0) return null;
  if (daysLeft >= 60) return `~${fmt(remaining / (daysLeft / 30))} ر.س/شهر`;
  if (daysLeft >= 14) return `~${fmt(remaining / (daysLeft / 7))} ر.س/أسبوع`;
  return `~${fmt(remaining / daysLeft)} ر.س/يوم`;
}

function GoalsSection({ goals, addGoal, updateGoalSaved, updateGoalDate, updateGoalTarget, updateGoal, deleteGoal }) {
  const colors = useColors();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDateInput, setTargetDateInput] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editSaved, setEditSaved] = useState('');
  const [editTarget, setEditTarget] = useState('');
  const [editingDateId, setEditingDateId] = useState(null);
  const [editDateVal, setEditDateVal] = useState('');
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };
  const today = startOfDay(new Date());

  function submit() {
    const t = Number(target);
    if (!name.trim() || !(t > 0)) return;
    addGoal({ name: name.trim(), target: t, targetDate: targetDateInput || undefined });
    setName(''); setTarget(''); setTargetDateInput(''); setShowAdd(false);
  }
  function openEdit(g) { setEditingId(g.id); setEditSaved(String(g.saved)); setEditTarget(String(g.target)); }
  function saveEdit(g) {
    const v = Number(editSaved), t = Number(editTarget);
    const patch = {};
    if (!isNaN(v) && v >= 0) patch.saved = v;
    if (!isNaN(t) && t > 0) patch.target = t;
    if (Object.keys(patch).length) updateGoal(g.id, patch);
    setEditingId(null);
  }
  function openDateEdit(g) { setEditingDateId(g.id); setEditDateVal(g.targetDate || ''); }
  function saveDateEdit(g) {
    updateGoalDate(g.id, editDateVal || undefined);
    setEditingDateId(null);
  }

  return (
    <div className="mt-4">
      <div style={{ background: colors.surface }} className="rounded-2xl p-4">
        <div className="flex items-center gap-2.5 mb-1.5">
          <div style={{ background: colors.surface2 }} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[15px]">🎯</div>
          <div className="flex flex-col">
            <span className="text-[12.5px] font-bold" style={{ color: colors.paper }}>أهدافك الادخارية</span>
            <span className="text-[10.5px]" style={{ color: colors.muted }}>كل خطوة تسدّدها تقربك من هدفك</span>
          </div>
        </div>
        <span className="text-[10px] block mb-3" style={{ color: colors.muted, opacity: 0.75, marginRight: 42 }}>💡 تتابعها بنفسك - ما نتحقق من السداد الفعلي</span>

        {goals.length === 0 && !showAdd ? (
          <div style={{ background: colors.surface2 }} className="rounded-2xl p-4 text-center">
            <span className="text-[13px]" style={{ color: colors.muted }}>ما ضفت أي هدف لسه</span>
          </div>
        ) : (
          <div className="daystrip flex gap-2.5 overflow-x-auto pb-1" style={{ scrollSnapType: 'x proximity' }}>
            {goals.map((g) => {
              const pct = Math.min(100, Math.round((g.saved / g.target) * 100));
              const barColor = pct >= 100 ? colors.good : colors.warn;
              const remaining = Math.max(0, g.target - g.saved);
              const daysLeft = g.targetDate ? diffDays(today, parseISO(g.targetDate)) : null;
              const pace = g.targetDate && pct < 100 ? goalPaceText(remaining, daysLeft) : null;
              const overdue = g.targetDate && pct < 100 && daysLeft <= 0;
              return (
                <div key={g.id} style={{ background: colors.surface2, minWidth: 210, scrollSnapAlign: 'center' }} className="rounded-2xl p-3.5 shrink-0">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[13px] font-bold truncate" style={{ color: colors.paper }}>{g.name}</span>
                    <button onClick={() => deleteGoal(g.id)} aria-label="حذف" className="shrink-0"><X size={13} color={colors.muted} /></button>
                  </div>
                  {editingId === g.id ? (
                    <div className="flex flex-col gap-1.5 mb-2">
                      <div className="flex gap-2">
                        <input type="number" inputMode="decimal" placeholder="وفّرت" value={editSaved} onChange={(e) => setEditSaved(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[12.5px] num flex-1 min-w-0" />
                        <input type="number" inputMode="decimal" placeholder="المستهدف" value={editTarget} onChange={(e) => setEditTarget(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[12.5px] num flex-1 min-w-0" />
                      </div>
                      <button onClick={() => saveEdit(g)} style={{ background: colors.warn, color: colors.ink }} className="rounded-lg py-1.5 text-[12px] font-bold">حفظ</button>
                    </div>
                  ) : (
                    <div className="text-[11px] mb-2" style={{ color: colors.muted }}>
                      <span className="num" style={{ color: colors.paper }}>{fmt(g.saved)}</span> / {fmt(g.target)} ر.س
                      <button onClick={() => openEdit(g)} className="mr-2 font-bold" style={{ color: colors.warn }}>عدّل هدفك</button>
                    </div>
                  )}
                  <div style={{ background: colors.surface, height: 8 }} className="rounded-full overflow-hidden">
                    <div style={{ width: `${pct}%`, background: barColor, height: '100%', transition: 'width 0.3s' }} />
                  </div>
                  <div className="flex justify-between items-center mt-1.5">
                    <span className="text-[10.5px] font-bold" style={{ color: colors.good, opacity: pct >= 100 ? 1 : 0 }}>هدف محقق ✓</span>
                    <span className="num text-[13px] font-extrabold display" style={{ color: barColor }}>{pct}%</span>
                  </div>
                  <div style={{ background: pct >= 100 ? 'rgba(62,217,160,0.1)' : colors.surface }} className="rounded-lg px-2.5 py-1.5 mt-2">
                    <span className="text-[10px] leading-snug" style={{ color: colors.paper }}>{goalMotivation(pct, g.name)}</span>
                  </div>

                  {pct < 100 && (
                    editingDateId === g.id ? (
                      <div className="flex gap-2 mt-2">
                        <input type="date" value={editDateVal} onChange={(e) => setEditDateVal(e.target.value)} style={inputStyle} className="rounded-lg px-2.5 py-1.5 text-[11.5px] num flex-1" />
                        <button onClick={() => saveDateEdit(g)} style={{ background: colors.warn, color: colors.ink }} className="rounded-lg px-3 text-[12px] font-bold">حفظ</button>
                      </div>
                    ) : g.targetDate ? (
                      overdue ? (
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px]" style={{ color: colors.muted }}>تجاوزت التاريخ اللي حددته</span>
                          <button onClick={() => openDateEdit(g)} className="text-[10px] font-bold" style={{ color: colors.warn }}>مدّده</button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px]" style={{ color: colors.muted }}>تحتاج <b style={{ color: colors.paper }}>{pace}</b></span>
                          <button onClick={() => openDateEdit(g)} className="text-[9.5px]" style={{ color: colors.muted }}>تعديل</button>
                        </div>
                      )
                    ) : (
                      <button onClick={() => openDateEdit(g)} className="text-[10px] font-bold mt-2" style={{ color: colors.warn }}>+ حدد تاريخ مستهدف</button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showAdd ? (
          <div style={{ background: colors.surface2 }} className="rounded-2xl p-4 mt-3 flex flex-col gap-3">
            <Field label="اسم الهدف">
              <input type="text" placeholder="مثال: سداد فيزا" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px]" />
            </Field>
            <Field label="المبلغ المستهدف">
              <input type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
            </Field>
            <Field label="تحب توصل له متى؟ (اختياري)">
              <input type="date" value={targetDateInput} onChange={(e) => setTargetDateInput(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
            </Field>
            <div className="flex gap-2">
              <button onClick={submit} className="flex-1 rounded-xl py-2.5 text-[13.5px] font-bold" style={{ background: colors.warn, color: colors.ink }}>إضافة</button>
              <button onClick={() => setShowAdd(false)} className="flex-1 rounded-xl py-2.5 text-[13.5px]" style={{ background: colors.surface2, color: colors.paper }}>إلغاء</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAdd(true)} className="w-full rounded-2xl py-3 mt-3 font-bold text-[13.5px]" style={{ background: colors.surface2, color: colors.warn }}>+ أضف هدف ادخاري جديد</button>
        )}
      </div>
    </div>
  );
}

function AboutView({ onBack, theme, toggleTheme }) {
  const colors = useColors();
  const paragraphs = [
    { type: 'p', text: 'نظرية المتوسط المالي ما بدأت كفكرة تجارية - بدأت كتجربة شخصية حقيقية. جربنا نفس الطريقة يدويًا على أنفسنا، ورأينا بأم أعيننا كيف رقم واحد بسيط يقدر يغيّر علاقتك كلها بفلوسك، من قلق وتخمين آخر كل شهر، إلى وضوح تام كل يوم.' },
    { type: 'p', text: 'من هالتجربة، أخذنا شهور - مو أيام - نطوّر ونجرب ونعيد. اختبرنا الفكرة على عدد من الأشخاص قبل ما توصلك بهالشكل، وشفنا بأنفسنا كيف نجحت معهم وغيّرت طريقة تعاملهم مع رواتبهم. كل مرة كنا نكتشف شي جديد، نرجع نعدّل، نبسّط أكثر، نحذف اللي ما يلزم ونركّز على اللي يفرق فعلاً.' },
    { type: 'p', text: 'النتيجة اللي بين يدينك الحين: مدخل واحد بس، وتلقى كل بياناتك جاهزة قدامك. ما تحتاج تحسب، ما تحتاج تصنّف مصاريفك، ما تحتاج تتعب. كل هالتعب أخذناه إحنا عنك، عشان توصلك التجربة بأسهل وأريح طريقة ممكنة.', bold: 'مدخل واحد بس، وتلقى كل بياناتك جاهزة قدامك.' },
    { type: 'p', text: 'خلف كل تفصيلة بسيطة تشوفها - كل رقم، كل لون، كل خطوة - فيه سبب مدروس وقرار اتاخذ بعناية. ما فيه شي بالصدفة. كل هذا عشان تحس إن التطبيق مبني لك أنت بالذات، مو حل عام يناسب الكل.' },
    { type: 'h', text: 'ليش مو زي باقي تطبيقات تتبع المصاريف؟' },
    { type: 'p', text: 'أغلب التطبيقات المالية تطلب منك تسجّل كل عملية صرف لحالها - قهوة، بنزين، عشا... وهذا بالضبط اللي يخلي الناس توقف عن استخدامها بعد أسبوعين.' },
    { type: 'p', text: 'كل اللي عليك: تفتح حسابك البنكي، وتحط كم باقي معك بالضبط - رقم واحد بس، كل يوم. والتطبيق يحسب لك كم صرفت اليوم وكل الأيام تلقائيًا من نفس الرقم، بدون ما تسجّل ولا عملية شراء لحالها.' },
    { type: 'p', text: 'هدفنا الحقيقي مو التطبيق نفسه - هدفنا التغيير اللي يصير فيك. لما تصير السيطرة على راتبك عادة يومية بسيطة، مو هم شهري يطاردك.' },
  ];

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>
      <h1 className="display text-[22px] font-black mb-4" style={{ color: colors.paper }}>من نحن</h1>
      <div style={{ background: colors.surface }} className="rounded-2xl p-5 flex flex-col gap-4">
        {paragraphs.map((p, i) => (
          p.type === 'h'
            ? <h2 key={i} className="display text-[16px] font-bold mt-1" style={{ color: colors.paper }}>{p.text}</h2>
            : <p key={i} className="text-[14px] leading-relaxed" style={{ color: colors.paper }}>{p.text}</p>
        ))}
      </div>
    </div>
  );
}

const FAQ_ITEMS = [
  { q: 'أبي أشتري شي غالي وحدّي اليومي أقل بكثير من سعره - وش أسوي؟', a: 'فيه ٣ طرق، كل ما صبرت أكثر كان أفضل لك:\n\n❌ الأسوأ: تشتريه على طول وحدّك لسه أقل من سعره بكثير - هذا يكسر متوسطك ويأثر على باقي شهرك.\n\n⚠️ جيدة: تخلي متوسطك ما ينزل (تصرف بحدود حدّك اليومي بس)، وتجمع الفائض بمحفظة خارجية لحاله لين يكمل سعر الغرض، وتشتريه من فلوس جمّعتها بره النظام.\n\n✅ الأفضل: تصبر وتوفر من حدّك اليومي، وتخليه يرتفع تدريجيًا لين يوصل نفس سعر الغرض - وتشتريه من داخل النظام وأنت مرتاح، بدون ما يأثر على أي شي.' },
  { q: 'ليش اسمه "نظرية المتوسط المالي"؟', a: 'كثير من الناس رواتبهم ممتازة وتكفي بالفعل - بس المشكلة مو بالرقم، المشكلة إن الراتب "يطير" قبل نهاية الشهر بخمسة أو ستة أيام، أو حتى بنص الشهر أحيانًا، وما تعرف بالضبط وين راح. تصرف براحتك أول الشهر، وتلقى نفسك ضايق آخره بدون ما تفهم السبب.\n\n"المتوسط المالي" هو الحل لهالمشكلة بالذات: بدل ما تصرف عشوائي وتكتشف الوضع متأخر، نديك أشبه بمجهر يوضح لك وضعك كل يوم - رقم واحد بسيط يخليك متحكم براتبك من أول يوم لآخر يوم، بدل ما راتبك هو اللي يتحكم فيك.' },
  { q: 'هل التطبيق يساعدني على الادخار؟', a: 'نعم، بس بطريقة مختلفة عن الادخار التقليدي. كثير من الناس يحاولون يدّخرون مبلغ ثابت كل شهر، وهذي من أكثر طرق الادخار فشلًا - لأن فيه أشهر مصروفاتها موسمية أو أعلى من العادي (رمضان، بداية المدارس، مناسبات)، فلما تجبر نفسك على رقم ثابت، تحس بالضغط وتفشل بسرعة.\n\nهنا الادخار يصير نتيجة طبيعية، مو التزام مفروض. لما ترفع متوسطك اليومي، الفرق ما يضيع - يرتفع متوسطك تلقائيًا، ويصير عندك مساحة أكبر تصرف منها الأيام الجايه، أو تخليها زيادة توفرها آخر الدورة.' },
  { q: 'هل فيه تحدي معين بنظرية المتوسط المالي؟', a: 'أكبر تحدي هو أول أسبوع من الراتب - هذي أخطر مرحلة بالدورة كلها، وأهم مرحلة تركّز فيها.\n\nليش؟ لأنك جالس تغيّر عادة، والعادة ما تتغيّر بضغطة زر. لو أول أسبوع صرفت أكثر من اللازم، متوسطك اليومي بينزل - وهذا طبيعي وما يعني إنك فشلت.\n\nأهم شي: لا تعاند، ولا تترك النظام. التغيير الحقيقي يصير بالاستمرار، مو بالكمال من أول يوم.' },
  { q: 'هل بياناتي ومعلوماتي المالية آمنة؟', a: 'التطبيق ما يتصل بحسابك البنكي أبدًا ولا يطلب منك أي بيانات دخول أو أرقام حسابات. كل اللي تسويه إنك تفتح تطبيق بنكك بنفسك (بره تطبيقنا)، تشوف رصيدك، وتكتبه يدويًا عندنا كرقم بس.' },
  { q: 'راتبي مو ثابت - هل ينفع لي؟', a: 'نعم. النظام أصلاً مبني على "كم باقي معك الحين" مو على رقم راتب ثابت من البداية. حتى لو دخلك يتغير، تقدر تحدّث رصيدك أي وقت يوصلك دخل جديد، والمتوسط يعدّل نفسه تلقائيًا على أساس الرقم الجديد.' },
  { q: 'وش يصير لو فوّت يوم أو يومين ما سجلت فيهم؟', a: 'ولا يهمك، ما ينكسر شي. أول ما ترجع تسجّل رصيدك، النظام يحسب تلقائيًا الفرق ويعدّل متوسطك على أساس الأيام اللي فاتت. بس كل ما سجّلت بانتظام أكثر، صار حسابك أدق.' },
  { q: 'مين المناسب له هالتطبيق بالضبط؟', a: 'أي شخص يحس إن راتبه "يطير" بدون ما يعرف بالضبط وين، أو حتى لو راتبه يكفيه لكن يبي يدّخر بطريقة مريحة وبدون ضغط. النظام يخدم الحالتين بنفس البساطة.' },
  { q: 'كم يستغرق أشوف نتيجة فعلية؟', a: 'مو من أول يوم، وهذا طبيعي. أول أسبوع بتحس إنك لسه تتعلم النظام. غالبًا من نهاية الدورة الأولى (شهر تقريبًا) بتلاحظ فرق واضح - إما وفرت مبلغ، أو على الأقل عرفت بالضبط وين كانت "التسريبات" اللي كانت تضيع منك بدون ما تحس.' },
  { q: 'وش يصير لو تجاوزت راتبي بالكامل ووصلت للصفر أو أقل؟', a: 'النظام يوريك بوضوح تام إذا وصلت لهالمرحلة (يتحول لونه للأحمر). هذا أصعب سيناريو، بس أهم فايدة فيه إنك تكتشفه بدري بدل ما تكتشفه آخر الشهر فجأة.' },
  { q: 'ليش أثق فيه أكثر من جدول إكسل أو مفكرة أسويها بنفسي؟', a: 'ما فيه شي غلط بجدول إكسل - المشكلة إنه يحتاج انضباط يومي إنك تفتحه وتحسب يدوي، وهذا بالضبط اللي يخلي أغلب الناس يبدأون بحماس ويوقفون بعد أسبوعين. إحنا سوينا نفس الفكرة، بس شلنا عنك الجزء المتعب (الحساب اليدوي)، وخليناها بضغطة وحدة.' },
  { q: 'هل تطّلعون على بياناتي؟', a: 'لا. بياناتك خاصة فيك بس، وما يهمنا نشوفها ولا نراقبها - التطبيق مصمم من الأساس عشان يخدمك أنت، مو عشاننا نجمع معلومات عنك. الرقم اللي تسجّله كل يوم يبقى بينك وبين حسابك، وما له علاقة فينا كأصحاب المنتج.' },
  { q: 'وش يصير لما راتبي الجديد ينزل؟ هل أبدأ من الصفر؟', a: 'لا، ما تبدأ من الصفر بالكامل. أول ما ينزل راتبك الجديد، يطلع لك ملخص أداء دورتك اللي خلصت (نسبة التزامك، أفضل وأسوأ يوم، سلسلتك)، وبعدها تدخل رقمك الجديد وتبدأ دورة جديدة.' },
  { q: 'غلطت وكتبت رقم خطأ برصيدي، أقدر أعدله؟', a: 'أكيد. ارجع لنفس اليوم من شريط الأيام وعدّل الرقم في أي وقت تبيه، ما فيه قفل نهائي على أي يوم مسجّل.' },
  { q: 'هل فيه مسؤولية أو ضمان على قراراتي المالية؟', a: 'التطبيق أداة تنظيم وتوضيح لوضعك المالي بناءً على البيانات اللي تدخلها بنفسك - مو استشارة مالية احترافية ولا بديل عن مستشار مالي مرخّص. القرارات المالية وتبعاتها تبقى مسؤوليتك أنت.' },
];

function FaqView({ onBack, theme, toggleTheme }) {
  const colors = useColors();
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>
      <h1 className="display text-[22px] font-black mb-4" style={{ color: colors.paper }}>الأسئلة الشائعة</h1>
      <div className="flex flex-col gap-2.5">
        {FAQ_ITEMS.map((item, i) => {
          const isOpen = openIndex === i;
          return (
            <div key={i} style={{ background: colors.surface }} className="rounded-2xl overflow-hidden">
              <button
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className="w-full flex items-center justify-between px-4 py-3.5 text-right"
              >
                <span className="text-[13.5px] font-bold flex-1" style={{ color: colors.paper }}>{item.q}</span>
                <ChevronLeft size={16} color={colors.muted} style={{ transform: isOpen ? 'rotate(-90deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
              </button>
              {isOpen && (
                <div className="px-4 pb-4">
                  <p className="text-[13px] leading-relaxed whitespace-pre-line" style={{ color: colors.muted }}>{item.a}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Onboarding(props) {
  const colors = useColors();
  const {
    nameInput, setNameInput,
    netInput, setNetInput, paydayInput, setPaydayInput, previewCycleDays,
    showCalc, setShowCalc, salaryCalc, setSalaryCalc,
    commitDraft, commitName, setCommitName, commitAmount, setCommitAmount,
    addCommitDraft, removeCommitDraft, applyCalc, canStart, completeSetup, theme, toggleTheme,
  } = props;
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };
  const calcTotal = commitDraft.reduce((s, c) => s + c.amount, 0);
  const calcNet = salaryCalc ? Number(salaryCalc) - calcTotal : null;

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <div style={{ background: colors.warn }} className="w-8 h-8 rounded-full flex items-center justify-center"><Wallet size={16} color={colors.ink} /></div>
          <span className="display text-[15px] font-bold" style={{ color: colors.paper }}>المتوسط المالي</span>
        </div>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <h1 className="display text-[26px] font-black leading-tight mt-3" style={{ color: colors.paper }}>كم يبقى لك بعد التزاماتك؟</h1>
      <p className="text-[14px] mt-2 leading-relaxed" style={{ color: colors.muted }}>أدخل المبلغ اللي فاضي لك للصرف هالدورة، وبنحسب لك حدّك اليومي تلقائي حسب تاريخ راتبك.</p>

      <div style={{ background: colors.surface }} className="rounded-2xl p-5 mt-6 flex flex-col gap-4">
        <Field label="وش اسمك؟">
          <input type="text" placeholder="مثال: خالد" value={nameInput} onChange={(e) => setNameInput(e.target.value)} style={inputStyle} className="rounded-xl px-4 py-3 text-[15px]" />
        </Field>

        <Field label="المبلغ المتبقي لك (ريال)">
          <input type="number" inputMode="decimal" placeholder="مثال: 3500" value={netInput} onChange={(e) => setNetInput(e.target.value)} style={inputStyle} className="rounded-xl px-4 py-3 text-[15px] num" />
        </Field>

        <button onClick={() => setShowCalc(!showCalc)} className="flex items-center gap-1.5 text-[12.5px] self-start" style={{ color: colors.warn }}>
          <Calculator size={13} />{showCalc ? 'إخفاء الحاسبة' : 'ما تعرف الرقم بالضبط؟ خلني أحسبه لك'}
        </button>

        {showCalc && (
          <div style={{ background: colors.surface2 }} className="rounded-xl p-3.5 flex flex-col gap-3">
            <Field label="راتبك الشهري">
              <input type="number" inputMode="decimal" placeholder="مثال: 8000" value={salaryCalc} onChange={(e) => setSalaryCalc(e.target.value)} style={{ ...inputStyle, background: colors.surface }} className="rounded-lg px-3 py-2 text-[14px] num" />
            </Field>
            <div className="flex gap-2">
              <input type="text" placeholder="اسم الالتزام" value={commitName} onChange={(e) => setCommitName(e.target.value)} style={{ ...inputStyle, background: colors.surface }} className="rounded-lg px-3 py-2 text-[13.5px] flex-[1.4] min-w-0" />
              <input type="number" inputMode="decimal" placeholder="المبلغ" value={commitAmount} onChange={(e) => setCommitAmount(e.target.value)} style={{ ...inputStyle, background: colors.surface }} className="rounded-lg px-3 py-2 text-[13.5px] num flex-1 min-w-0" />
              <button onClick={addCommitDraft} style={{ background: colors.surface, color: colors.paper }} className="rounded-lg w-9 flex items-center justify-center shrink-0"><Plus size={16} /></button>
            </div>
            {commitDraft.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-1.5" style={{ background: colors.surface }}>
                <span className="text-[13px]" style={{ color: colors.paper }}>{c.name}</span>
                <div className="flex items-center gap-2"><span className="num text-[13px]" style={{ color: colors.muted }}>{fmt(c.amount)}</span><button onClick={() => removeCommitDraft(c.id)}><X size={13} color={colors.muted} /></button></div>
              </div>
            ))}
            {calcNet !== null && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[12.5px]" style={{ color: colors.muted }}>الصافي المتبقي</span>
                <span className="num text-[15px] font-bold" style={{ color: calcNet >= 0 ? colors.good : colors.bad }}>{fmt(calcNet)} ر.س</span>
              </div>
            )}
            <button onClick={applyCalc} disabled={!(calcNet > 0)} style={{ background: calcNet > 0 ? colors.warn : colors.surface, color: calcNet > 0 ? colors.ink : colors.muted }} className="rounded-lg py-2 text-[13px] font-bold mt-1">استخدم هذا الرقم</button>
          </div>
        )}

        <div className="h-px" style={{ background: colors.line }} />

        <Field label="أي يوم بالشهر ينزل راتبك؟">
          <div className="flex items-center gap-2">
            <Calendar size={16} color={colors.muted} className="shrink-0" />
            <input type="number" inputMode="numeric" min="1" max="31" placeholder="مثال: 26" value={paydayInput} onChange={(e) => setPaydayInput(e.target.value)} style={inputStyle} className="rounded-xl px-4 py-3 text-[15px] num flex-1" />
          </div>
        </Field>
        {previewCycleDays && (
          <span className="text-[12px]" style={{ color: colors.muted }}>دورتك هذي {previewCycleDays} يوم — نحسبها حسب تقويم الشهر الفعلي</span>
        )}
      </div>

      {canStart && previewCycleDays && (
        <div className="rounded-2xl p-4 mt-4 flex items-center justify-between" style={{ background: colors.surface }}>
          <span className="text-[13px]" style={{ color: colors.muted }}>حدّك اليومي المتوقع</span>
          <span className="num text-[20px] font-extrabold display" style={{ color: colors.good }}>{fmt(Number(netInput) / previewCycleDays)} <span className="text-[13px] font-normal">ر.س</span></span>
        </div>
      )}

      <button onClick={completeSetup} disabled={!canStart} style={{ background: canStart ? colors.warn : colors.surface, color: canStart ? colors.ink : colors.muted }} className="w-full rounded-2xl py-4 mt-5 font-bold text-[15px] display flex items-center justify-center gap-2">
        ابدأ حساب المتوسط<ChevronLeft size={18} />
      </button>
    </div>
  );
}

function DayStrip({ totalDays, todayIndex, checkins, selectedDay, openDay, cycleStartDate }) {
  const colors = useColors();
  const scrollerRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => {
    if (activeRef.current && scrollerRef.current) {
      const container = scrollerRef.current, el = activeRef.current;
      container.scrollTo({ left: el.offsetLeft - container.clientWidth / 2 + el.clientWidth / 2, behavior: 'auto' });
    }
  }, []);

  const checkinMap = useMemo(() => { const m = {}; checkins.forEach((c) => { m[c.day] = c; }); return m; }, [checkins]);

  function dateLabel(d) {
    const dt = new Date(cycleStartDate);
    dt.setDate(dt.getDate() + d);
    return `${dt.getDate()} ${MONTHS_AR[dt.getMonth()]}`;
  }

  return (
    <div ref={scrollerRef} className="daystrip flex gap-2 overflow-x-auto pb-1" style={{ scrollSnapType: 'x proximity' }}>
      {Array.from({ length: totalDays }).map((_, d) => {
        const isToday = d === todayIndex, isSelected = d === selectedDay, isFuture = d > todayIndex, hasEntry = !!checkinMap[d];
        const missed = d < todayIndex && !hasEntry;
        let bg = colors.surface2, fg = colors.muted, border = 'transparent';
        if (hasEntry) { bg = colors.good; fg = colors.ink; }
        if (missed || isFuture) { bg = 'transparent'; fg = colors.muted; border = colors.line; }
        if (isToday) { border = colors.warn; bg = hasEntry ? colors.good : colors.surface2; fg = hasEntry ? colors.ink : colors.paper; }
        // "selected" (the day you're viewing/editing) gets a distinct treatment from "today" so
        // the two never look identical when they're different days
        if (isSelected && !isToday) { border = colors.paper; }
        return (
          <button key={d} ref={isToday ? activeRef : null} onClick={() => !isFuture && openDay(d)} disabled={isFuture}
            style={{ background: bg, color: fg, border: `1.5px solid ${border}`, minWidth: 62, scrollSnapAlign: 'center', opacity: isFuture ? 0.5 : 1, boxShadow: isSelected ? `0 0 0 2px ${isToday ? colors.warn : colors.paper}33` : 'none' }}
            className="rounded-xl flex flex-col items-center justify-center py-2.5 shrink-0 transition-all">
            <span className="text-[10.5px] opacity-80">{isToday ? 'اليوم' : 'يوم'}</span>
            <span className="num text-[16px] font-bold leading-none mt-0.5">{d + 1}</span>
            <span className="text-[9px] opacity-70 mt-0.5">{dateLabel(d)}</span>
          </button>
        );
      })}
    </div>
  );
}

function MonthStrip({ dbCycles, setup, onViewHistory, disabled }) {
  const colors = useColors();
  const scrollerRef = useRef(null);
  const activeRef = useRef(null);

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonthIdx = now.getMonth(); // 0 = يناير

  // map each cycle recorded in Supabase to the calendar month/year it started in —
  // the active cycle is excluded here since it's rendered as "current" below instead
  const monthMap = {}; // key: `${year}-${monthIdx}` -> { type: 'history', cycleStart } | { type: 'current' }
  dbCycles.forEach((c) => {
    if (c.cycle_start_date === setup.cycleStart) return;
    const d = parseISO(c.cycle_start_date);
    monthMap[`${d.getFullYear()}-${d.getMonth()}`] = { type: 'history', cycleStart: c.cycle_start_date };
  });
  // "current" always tracks today's real calendar month — not the month the active cycle
  // happened to start in (a cycle can span two calendar months when payday isn't the 1st)
  monthMap[`${curYear}-${curMonthIdx}`] = { type: 'current' };

  useEffect(() => {
    if (activeRef.current && scrollerRef.current) {
      const container = scrollerRef.current, el = activeRef.current;
      container.scrollTo({ left: el.offsetLeft - container.clientWidth / 2 + el.clientWidth / 2, behavior: 'auto' });
    }
  }, []);

  return (
    <div ref={scrollerRef} className="daystrip flex gap-2 overflow-x-auto pb-1" style={{ scrollSnapType: 'x proximity' }}>
      {Array.from({ length: 12 }).map((_, m) => {
        const entry = monthMap[`${curYear}-${m}`];
        const isCurrent = entry?.type === 'current';
        const isFuture = m > curMonthIdx && !entry;
        const hasHistory = entry?.type === 'history';
        const isEmpty = !entry && !isFuture;

        let bg = colors.surface2, border = 'transparent', fg = colors.paper, opacity = 1;
        if (hasHistory) { bg = colors.good; fg = colors.ink; }
        if (isCurrent) { border = colors.warn; }
        if (isFuture || isEmpty) { bg = 'transparent'; border = colors.line; fg = colors.muted; opacity = isFuture ? 0.5 : 0.7; }

        const clickable = hasHistory && !disabled;

        return (
          <button
            key={m}
            ref={isCurrent ? activeRef : null}
            onClick={() => clickable && onViewHistory(entry.cycleStart)}
            disabled={!clickable}
            style={{ background: bg, color: fg, border: `1.5px solid ${border}`, minWidth: 64, opacity, scrollSnapAlign: 'center' }}
            className="rounded-xl flex flex-col items-center justify-center py-2.5 shrink-0 transition-all"
          >
            <span className="text-[10.5px] opacity-80">شهر</span>
            <span className="num text-[16px] font-bold leading-none mt-0.5">{m + 1}</span>
            {isCurrent && <span className="text-[9px] mt-0.5" style={{ color: colors.warn }}>الحالي</span>}
            {isFuture && <Lock size={11} className="mt-1" />}
          </button>
        );
      })}
    </div>
  );
}

function PulseChart({ pulseData, color }) {
  const data = pulseData.slice(-14);
  if (data.length < 2) return <div style={{ height: 64 }} />;
  return (
    <div style={{ height: 64 }} className="mt-3 relative">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}><YAxis hide domain={['dataMin - 5', 'dataMax + 5']} /><Line type="monotone" dataKey="value" stroke={color} strokeWidth={2.5} dot={false} isAnimationActive={false} /></LineChart>
      </ResponsiveContainer>
      <span style={{ position: 'absolute', left: 0, top: '50%', width: 7, height: 7, borderRadius: '50%', background: color, transform: 'translateY(-50%)' }} />
      <span style={{ position: 'absolute', left: 0, top: '50%', width: 7, height: 7, borderRadius: '50%', background: color, transform: 'translateY(-50%)', animation: 'dotpulse 1.6s ease-out infinite' }} />
    </div>
  );
}

function StatChip({ label, value }) {
  const colors = useColors();
  return (
    <div style={{ background: colors.surface }} className="rounded-xl px-2.5 py-3 flex-1 min-w-0">
      <div className="text-[10.5px] leading-snug" style={{ color: colors.muted }}>{label}</div>
      <div className="num text-[15px] font-bold mt-1 truncate" style={{ color: colors.paper }}>{value}</div>
    </div>
  );
}

// two related stats joined in one card, split by a thin divider — used where the numbers
// belong together conceptually (e.g. starting amount + what's left of it)
function StatChipGroup({ items }) {
  const colors = useColors();
  return (
    <div style={{ background: colors.surface }} className="rounded-xl flex overflow-hidden">
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <div style={{ width: 1, background: colors.line }} />}
          <div className="px-2.5 py-3 flex-1 min-w-0">
            <div className="text-[10.5px] leading-snug" style={{ color: colors.muted }}>{it.label}</div>
            <div className="num text-[15px] font-bold mt-1 truncate" style={{ color: colors.paper }}>{it.value}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function ChartCard({ title, children }) {
  const colors = useColors();
  return (
    <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3">
      <span className="text-[13px] font-bold" style={{ color: colors.paper }}>{title}</span>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function EmptyChartCard({ text }) {
  const colors = useColors();
  return (
    <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3 text-center">
      <span className="text-[12.5px]" style={{ color: colors.muted }}>{text}</span>
    </div>
  );
}

function LegendDot({ dotColor, label, dashed }) {
  const colors = useColors();
  return (
    <div className="flex items-center gap-1.5">
      <span style={{ width: 10, height: dashed ? 2 : 8, background: dotColor, borderRadius: dashed ? 0 : 99 }} />
      <span className="text-[11px]" style={{ color: colors.muted }}>{label}</span>
    </div>
  );
}

function DailySpendChart({ results }) {
  const colors = useColors();
  if (!results || results.length < 1) return <EmptyChartCard text="سجّل رصيدك كم يوم عشان يظهر لك شارت صرفك اليومي" />;
  const data = results.map((r) => ({ day: String(r.day + 1), spend: Math.round(r.avgDaily), good: r.good, neutral: r.neutral }));
  return (
    <ChartCard title="صرفك كل يوم">
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 20, right: 4, left: 4, bottom: 0 }}>
          <XAxis dataKey="day" tick={{ fontSize: 10, fill: colors.muted }} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Bar dataKey="spend" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d, i) => (<Cell key={i} fill={d.neutral ? colors.warn : d.good ? colors.good : colors.bad} />))}
            <LabelList dataKey="spend" position="top" style={{ fontSize: 10, fill: colors.paper, fontFamily: 'Cairo' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        <LegendDot dotColor={colors.good} label="ضمن حدّك" />
        <LegendDot dotColor={colors.bad} label="تجاوزت" />
        <LegendDot dotColor={colors.warn} label="دخل إضافي" />
      </div>
    </ChartCard>
  );
}

function IdealPathChart({ setup, totalDays, baselineDaily, sortedCheckins }) {
  const colors = useColors();
  const data = useMemo(() => {
    const arr = [];
    for (let d = 0; d <= totalDays; d++) arr.push({ day: d + 1, ideal: Math.max(0, Math.round(setup.netStart - baselineDaily * d)) });
    if (arr[0]) arr[0].actual = setup.netStart;
    sortedCheckins.forEach((c) => { if (arr[c.day]) arr[c.day].actual = c.balance; });
    return arr;
  }, [setup, totalDays, baselineDaily, sortedCheckins]);

  if (!sortedCheckins.length) return <EmptyChartCard text="سجّل رصيدك كم يوم عشان تشوف مسارك الفعلي مقابل المثالي" />;

  const tickStep = Math.max(1, Math.ceil(totalDays / 6));

  return (
    <ChartCard title="مسارك مقابل المسار المثالي">
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <XAxis
            dataKey="day" tick={{ fontSize: 10, fill: colors.muted }} axisLine={false} tickLine={false}
            interval={tickStep - 1}
          />
          <YAxis hide />
          <Line type="monotone" dataKey="ideal" stroke={colors.muted} strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="actual" stroke={colors.warn} strokeWidth={2.5} dot={{ r: 3, fill: colors.warn }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-3 mt-1">
        <LegendDot dotColor={colors.muted} label="المسار المثالي" dashed />
        <LegendDot dotColor={colors.warn} label="رصيدك الفعلي" />
      </div>
    </ChartCard>
  );
}

function ComplianceDonut({ stats }) {
  const colors = useColors();
  if (!stats || !stats.scored || stats.scored.length < 1) return <EmptyChartCard text="سجّل رصيدك كم يوم عشان تطلع لك نسبة التزامك" />;
  const goodCount = stats.scored.filter((r) => r.good).length;
  const badCount = stats.scored.length - goodCount;
  const data = [{ name: 'ملتزم', value: goodCount }, { name: 'تجاوز', value: badCount || 0.0001 }];
  return (
    <ChartCard title="نسبة التزامك">
      <div className="flex items-center gap-4">
        <div style={{ width: 110, height: 110 }} className="relative shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" innerRadius={32} outerRadius={50} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                <Cell fill={colors.good} />
                <Cell fill={colors.bad} />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="num text-[18px] font-extrabold display" style={{ color: colors.paper }}>{stats.complianceRate}%</span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <LegendDot dotColor={colors.good} label={`ملتزم (${goodCount} يوم)`} />
          <LegendDot dotColor={colors.bad} label={`تجاوز (${badCount} يوم)`} />
        </div>
      </div>
    </ChartCard>
  );
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawShareCard({ colors, name, stats, avgSpend, baselineDaily, status }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = colors.ink;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pad = 56;
  const cardX = pad, cardY = pad, cardW = canvas.width - pad * 2, cardH = canvas.height - pad * 2;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 40);
  ctx.fillStyle = colors.surface;
  ctx.fill();

  const cx = canvas.width / 2;
  let cy = cardY + 90;

  ctx.beginPath();
  ctx.arc(cx, cy, 42, 0, Math.PI * 2);
  ctx.fillStyle = colors.warn;
  ctx.fill();
  ctx.font = '42px sans-serif';
  ctx.fillText('💰', cx, cy + 4);

  cy += 90;
  ctx.font = '600 32px Tajawal, sans-serif';
  ctx.fillStyle = colors.paper;
  ctx.fillText('المتوسط المالي', cx, cy);

  cy += 80;
  ctx.font = '900 44px Cairo, sans-serif';
  ctx.fillStyle = colors.paper;
  ctx.fillText(name ? `بطاقة إنجاز ${name}` : 'بطاقة إنجازي', cx, cy);

  cy += 110;
  const statusColor = status === 'good' ? colors.good : status === 'warn' ? colors.warn : colors.bad;
  ctx.font = '900 150px Cairo, sans-serif';
  ctx.fillStyle = statusColor;
  ctx.fillText(`${stats.complianceRate}%`, cx, cy);

  cy += 60;
  ctx.font = '400 28px Tajawal, sans-serif';
  ctx.fillStyle = colors.muted;
  ctx.fillText('نسبة الالتزام', cx, cy);

  cy += 70;
  // percentages only on the shareable card — some people are private about exact riyal amounts,
  // so we show how they did relative to their own budget, never the raw numbers
  const pctOfBudget = baselineDaily > 0 ? Math.round((avgSpend / baselineDaily) * 100) : null;
  const bestPct = baselineDaily > 0 && stats.best ? Math.round((stats.best.avgDaily / baselineDaily) * 100) : null;
  const boxes = [
    { label: 'سلسلتك الحالية', value: `${stats.currentStreak} يوم` },
    { label: 'أطول سلسلة', value: `${stats.longestStreak} يوم` },
    { label: 'متوسطك من حدّك اليومي', value: pctOfBudget != null ? `${pctOfBudget}%` : '—' },
    { label: stats.best ? `أفضل يوم (يوم ${stats.best.day + 1})` : 'أفضل يوم', value: bestPct != null ? `${bestPct}%` : '—' },
  ];
  const gridX = cardX + 60, gridW = cardW - 120, boxGap = 22;
  const boxW = (gridW - boxGap) / 2, boxH = 150;
  boxes.forEach((b, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const bx = gridX + col * (boxW + boxGap);
    const by = cy + row * (boxH + boxGap);
    roundRectPath(ctx, bx, by, boxW, boxH, 22);
    ctx.fillStyle = colors.surface2;
    ctx.fill();
    ctx.font = '400 24px Tajawal, sans-serif';
    ctx.fillStyle = colors.muted;
    ctx.fillText(b.label, bx + boxW / 2, by + 48);
    ctx.font = '700 38px Cairo, sans-serif';
    ctx.fillStyle = colors.paper;
    ctx.fillText(b.value, bx + boxW / 2, by + 100);
  });

  ctx.font = '500 26px Tajawal, sans-serif';
  ctx.fillStyle = colors.muted;
  ctx.fillText('نظرية المتوسط المالي 💪', cx, cardY + cardH - 50);

  return canvas;
}

function StatsSection({ stats, status, name, baselineDaily }) {
  const colors = useColors();
  const [cardImageUrl, setCardImageUrl] = useState(null);
  const [shareState, setShareState] = useState('idle'); // 'idle' | 'shared'

  if (!stats || stats.results.length < 1) {
    return (
      <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3 text-center">
        <span className="text-[13px]" style={{ color: colors.muted }}>سجّل رصيدك كم يوم عشان تطلع لك إحصائياتك هنا</span>
      </div>
    );
  }
  const scored = stats.scored && stats.scored.length ? stats.scored : stats.results;
  const avgSpend = scored.reduce((s, r) => s + r.avgDaily, 0) / scored.length;
  const motivation = (() => {
    if (status === 'good') return { text: stats.currentStreak >= 3 ? '🔥 مستمر بقوة! كمّل نفس الوتيرة' : 'وضعك ممتاز، استمر على نفس المسار', color: colors.good };
    if (status === 'warn') return { text: 'انتبه شوي، راقب صرفك بالأيام الجايه', color: colors.warn };
    return { text: 'ما تستسلم، كل يوم جديد فرصة توازن فيها', color: colors.bad };
  })();

  async function shareAchievement() {
    const canvas = drawShareCard({ colors, name, stats, avgSpend, baselineDaily, status });
    const dataUrl = canvas.toDataURL('image/png');
    setCardImageUrl(dataUrl);

    // best-effort native share with the actual image file (works on many mobile browsers)
    try {
      if (navigator.share && navigator.canShare) {
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const file = new File([blob], 'انجازي-المتوسط-المالي.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'بطاقة إنجازي' });
          setShareState('shared');
          setTimeout(() => setShareState('idle'), 1800);
        }
      }
    } catch (e) {
      // ignore — the card preview + download link below still works regardless
    }
  }

  return (
    <div className="mt-3">
      <span className="text-[12.5px] font-bold px-1" style={{ color: colors.muted }}>إحصائياتك</span>
      <div className="grid grid-cols-2 gap-2.5 mt-2">
        <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><Check size={14} color={colors.good} /><span className="text-[12px]" style={{ color: colors.muted }}>نسبة الالتزام</span></div>
          <span className="num text-[19px] font-extrabold display" style={{ color: colors.paper }}>{stats.complianceRate}%</span>
        </div>
        <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><Flame size={14} color={colors.warn} /><span className="text-[12px]" style={{ color: colors.muted }}>سلسلتك الحالية</span></div>
          <span className="num text-[19px] font-extrabold display" style={{ color: colors.paper }}>{stats.currentStreak} <span className="text-[12px] font-normal">يوم</span></span>
        </div>
        <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><Flame size={14} color={colors.good} /><span className="text-[12px]" style={{ color: colors.muted }}>أطول سلسلة</span></div>
          <span className="num text-[19px] font-extrabold display" style={{ color: colors.paper }}>{stats.longestStreak} <span className="text-[12px] font-normal">يوم</span></span>
        </div>
        <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5"><Wallet size={14} color={colors.muted} /><span className="text-[12px]" style={{ color: colors.muted }}>متوسط صرفك اليومي</span></div>
          <span className="num text-[17px] font-extrabold display" style={{ color: colors.paper }}>{fmt(avgSpend)} <span className="text-[11px] font-normal">ر.س</span></span>
        </div>
        {stats.best && (
          <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5"><Award size={14} color={colors.good} /><span className="text-[12px]" style={{ color: colors.muted }}>أفضل يوم</span></div>
            <span className="num text-[15px] font-bold" style={{ color: colors.paper }}>يوم {stats.best.day + 1}</span>
            <span className="text-[11px]" style={{ color: colors.muted }}>صرف {fmt(stats.best.avgDaily)} ر.س</span>
          </div>
        )}
        {stats.worst && (
          <div style={{ background: colors.surface }} className="rounded-xl p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5"><AlertTriangle size={14} color={colors.bad} /><span className="text-[12px]" style={{ color: colors.muted }}>أسوأ يوم</span></div>
            <span className="num text-[15px] font-bold" style={{ color: colors.paper }}>يوم {stats.worst.day + 1}</span>
            <span className="text-[11px]" style={{ color: colors.muted }}>صرف {fmt(stats.worst.avgDaily)} ر.س</span>
          </div>
        )}
      </div>
      <div style={{ background: colors.surface, borderRight: `3px solid ${motivation.color}` }} className="rounded-xl px-3.5 py-2.5 mt-2.5">
        <span className="text-[12.5px] font-bold" style={{ color: motivation.color }}>{motivation.text}</span>
      </div>
      <button
        onClick={shareAchievement}
        style={{ background: colors.surface, color: colors.paper }}
        className="w-full rounded-xl py-3 mt-2.5 flex items-center justify-center gap-2 text-[13px] font-bold"
      >
        {shareState === 'shared' ? <Check size={15} color={colors.good} /> : <Share2 size={15} />}
        {shareState === 'shared' ? 'تمت المشاركة!' : 'شارك إنجازك'}
      </button>
      {cardImageUrl && (
        <div style={{ background: colors.surface }} className="rounded-xl p-3 mt-2 flex flex-col gap-2.5">
          <img src={cardImageUrl} alt="بطاقة إنجازك" style={{ width: '100%', borderRadius: 14, display: 'block' }} />
          <a
            href={cardImageUrl}
            download="انجازي-المتوسط-المالي.png"
            style={{ background: colors.warn, color: colors.ink }}
            className="w-full rounded-lg py-2.5 flex items-center justify-center gap-1.5 text-[13px] font-bold"
          >
            تنزيل الصورة 📥
          </a>
          <span className="text-[11px] text-center" style={{ color: colors.muted }}>نزّلها وحطها بالستوري مباشرة</span>
        </div>
      )}
    </div>
  );
}

function LifetimeSummaryCard({ cycleHistory, currentStats }) {
  const colors = useColors();
  const totalMonths = cycleHistory.length + 1;

  const rates = [];
  cycleHistory.forEach((c) => {
    const cs = parseISO(c.setup.cycleStart);
    const ce = addCycleMonths(cs, 1, c.setup.paydayDom);
    const td = diffDays(cs, ce);
    const s = computeStats([...c.checkins].sort((a, b) => a.day - b.day), c.setup.originalNetStart ?? c.setup.netStart, td);
    if (s) rates.push(s.complianceRate);
  });
  if (currentStats) rates.push(currentStats.complianceRate);

  if (totalMonths < 2 || rates.length < 1) return null;

  const overallAvg = Math.round(rates.reduce((s, r) => s + r, 0) / rates.length);
  const bestRate = Math.max(...rates);

  return (
    <div style={{ background: colors.surface }} className="rounded-2xl p-4 mb-3">
      <span className="text-[12.5px] font-bold" style={{ color: colors.muted }}>مشوارك كامل</span>
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <div className="text-center">
          <div className="num text-[20px] font-extrabold display" style={{ color: colors.paper }}>{totalMonths}</div>
          <div className="text-[10px] mt-0.5" style={{ color: colors.muted }}>شهر</div>
        </div>
        <div className="text-center">
          <div className="num text-[20px] font-extrabold display" style={{ color: colors.paper }}>{overallAvg}%</div>
          <div className="text-[10px] mt-0.5" style={{ color: colors.muted }}>متوسط التزامك</div>
        </div>
        <div className="text-center">
          <div className="num text-[20px] font-extrabold display" style={{ color: colors.good }}>{bestRate}%</div>
          <div className="text-[10px] mt-0.5" style={{ color: colors.muted }}>أفضل شهر لك</div>
        </div>
      </div>
    </div>
  );
}

function WeekdayPatternCard({ stats, cycleStartDate }) {
  const colors = useColors();
  if (!stats || stats.scored.length < 3) return null;

  const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const buckets = {};
  stats.scored.forEach((r) => {
    const d = new Date(cycleStartDate);
    d.setDate(d.getDate() + r.day);
    const wd = d.getDay();
    if (!buckets[wd]) buckets[wd] = [];
    buckets[wd].push(r.avgDaily);
  });
  const averaged = Object.entries(buckets).map(([wd, vals]) => ({ wd: Number(wd), avg: vals.reduce((s, v) => s + v, 0) / vals.length }));
  if (averaged.length < 2) return null;
  const highest = averaged.reduce((a, b) => (b.avg > a.avg ? b : a));

  return (
    <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3">
      <span className="text-[13px] font-bold" style={{ color: colors.paper }}>نمط أيام الأسبوع</span>
      <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: colors.muted }}>
        تصرف أكثر أيام <span style={{ color: colors.warn, fontWeight: 'bold' }}>{WEEKDAYS[highest.wd]}</span> - متوسط {Math.round(highest.avg)} ر.س
      </p>
    </div>
  );
}

function MonthComplianceChart({ cycleHistory, currentStats }) {
  const colors = useColors();
  const data = useMemo(() => {
    const arr = cycleHistory.map((c, i) => {
      const cs = parseISO(c.setup.cycleStart);
      const ce = addCycleMonths(cs, 1, c.setup.paydayDom);
      const td = diffDays(cs, ce);
      const s = computeStats([...c.checkins].sort((a, b) => a.day - b.day), c.setup.originalNetStart ?? c.setup.netStart, td);
      return { label: `شهر ${i + 1}`, rate: s ? s.complianceRate : 0 };
    });
    if (currentStats) arr.push({ label: 'الحالي', rate: currentStats.complianceRate });
    return arr;
  }, [cycleHistory, currentStats]);

  if (data.length < 2) return null;

  return (
    <ChartCard title="تطور التزامك عبر الشهور">
      <ResponsiveContainer width="100%" height={130}>
        <BarChart data={data} margin={{ top: 18, right: 4, left: 4, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: colors.muted }} axisLine={false} tickLine={false} />
          <YAxis hide domain={[0, 100]} />
          <Bar dataKey="rate" radius={[4, 4, 0, 0]} fill={colors.warn} isAnimationActive={false}>
            <LabelList dataKey="rate" position="top" formatter={(v) => `${v}%`} style={{ fontSize: 10, fill: colors.paper, fontFamily: 'Cairo' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function Dashboard(props) {
  const colors = useColors();
  const {
    setup, dailyBudget, baselineDaily, status, pulseData, trendDelta,
    todayIndex, daysRemaining, totalDays, effectiveBalance, checkins, sortedCheckins,
    selectedDay, openDay, entryBalance, setEntryBalance, entryNote, setEntryNote,
    showExtraIncome, setShowExtraIncome, extraIncomeInput, setExtraIncomeInput,
    saveEntry, deleteEntry, justSaved, stats, cycleHistory, dbCycles, historyLoading, bills, addBill, deleteBill, updateBill,
    goals, addGoal, updateGoalSaved, updateGoalDate, updateGoalTarget, updateGoal, deleteGoal, onViewHistory, onSettings, theme, toggleTheme,
  } = props;

  const meta = { color: colors[status], ...statusMeta(status, setup.name) };
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };
  const isEditable = selectedDay <= todayIndex;
  const isToday = selectedDay === todayIndex;
  const selectedEntry = checkins.find((c) => c.day === selectedDay);

  const dayCompare = useMemo(() => {
    const map = {};
    if (stats) stats.results.forEach((r) => { map[r.day] = r.avgDaily; });
    let todayVal = map[todayIndex] ?? null;
    let yesterdayVal = map[todayIndex - 1] ?? null;
    let todayLabel = 'اليوم';
    let yesterdayLabel = 'أمس';
    // fallback: if there's no real entry for today/yesterday, compare the last two entries recorded so far
    if (todayVal == null && stats && stats.results.length >= 2) {
      const r = stats.results;
      todayVal = r[r.length - 1].avgDaily;
      yesterdayVal = r[r.length - 2].avgDaily;
      todayLabel = `يوم ${r[r.length - 1].day + 1}`;
      yesterdayLabel = `يوم ${r[r.length - 2].day + 1}`;
    }
    const delta = (todayVal != null && yesterdayVal != null) ? (yesterdayVal - todayVal) : null;
    return { todayVal, yesterdayVal, delta, todayLabel, yesterdayLabel };
  }, [stats, todayIndex]);

  const projection = useMemo(() => {
    if (!stats || !stats.results.length || daysRemaining <= 0) return null;
    const base = stats.scored && stats.scored.length ? stats.scored : stats.results;
    const avgSpendRate = base.reduce((s, r) => s + r.avgDaily, 0) / base.length;
    const projectedSpend = avgSpendRate * daysRemaining;
    const surplus = effectiveBalance - projectedSpend;
    return { avgSpendRate, surplus };
  }, [stats, daysRemaining, effectiveBalance]);

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div style={{ background: colors.warn }} className="w-7 h-7 rounded-full flex items-center justify-center"><Wallet size={14} color={colors.ink} /></div>
          <span className="display text-[14px] font-bold" style={{ color: colors.paper }}>المتوسط المالي</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          <button onClick={onSettings} aria-label="الإعدادات"><Settings2 size={19} color={colors.muted} /></button>
        </div>
      </div>

      {setup.name && (
        <p className="text-[13px] mb-3 px-0.5" style={{ color: colors.muted }}>أهلين {setup.name} 👋</p>
      )}

      <LifetimeSummaryCard cycleHistory={cycleHistory} currentStats={stats} />

      <div style={{ background: colors.surface }} className="rounded-3xl p-6">
        <div className="flex items-center justify-between">
          <span className="text-[13px]" style={{ color: colors.muted }}>حدّك اليومي</span>
          <span className="text-[12.5px] font-bold px-2.5 py-1 rounded-full" style={{ background: colors.surface2, color: meta.color }}>{meta.label}</span>
        </div>
        <div className="flex items-end gap-2 mt-2">
          <span className="num display font-black leading-none" style={{ fontSize: 52, color: meta.color, transition: 'color 0.3s' }}>{fmt(Math.max(0, dailyBudget))}</span>
          <span className="text-[15px] mb-1.5" style={{ color: colors.muted }}>ر.س / اليوم</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {trendDelta > 0.5 && <TrendingUp size={13} color={colors.good} />}
          {trendDelta < -0.5 && <TrendingDown size={13} color={colors.bad} />}
          {Math.abs(trendDelta) <= 0.5 && <Minus size={13} color={colors.muted} />}
          <span className="text-[12px]" style={{ color: colors.muted }}>{meta.sub}</span>
        </div>
        <PulseChart pulseData={pulseData} color={meta.color} />

        {dayCompare.yesterdayVal == null && dayCompare.todayVal == null ? (
          <div className="flex items-center justify-center mt-3 pt-3" style={{ borderTop: `1px solid ${colors.line}` }}>
            <span className="text-[11.5px]" style={{ color: colors.muted }}>سجّل رصيدك يومين متتاليين عشان تشوف مقارنة يومك بأمس</span>
          </div>
        ) : (
          <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: `1px solid ${colors.line}` }}>
            <div className="flex flex-col">
              <span className="text-[10.5px]" style={{ color: colors.muted }}>{dayCompare.yesterdayLabel}</span>
              <span className="num text-[13.5px] font-bold" style={{ color: colors.paper }}>{dayCompare.yesterdayVal != null ? `${fmt(dayCompare.yesterdayVal)} ر.س` : '—'}</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[10.5px]" style={{ color: colors.muted }}>{dayCompare.todayLabel}</span>
              <div className="flex items-center gap-1">
                <span className="num text-[13.5px] font-bold" style={{ color: colors.paper }}>{dayCompare.todayVal != null ? `${fmt(dayCompare.todayVal)} ر.س` : 'لسه'}</span>
                {dayCompare.todayVal != null && dayCompare.yesterdayVal != null && (
                  dayCompare.todayVal < dayCompare.yesterdayVal
                    ? <TrendingDown size={12} color={colors.good} />
                    : dayCompare.todayVal > dayCompare.yesterdayVal
                      ? <TrendingUp size={12} color={colors.bad} />
                      : <Minus size={12} color={colors.muted} />
                )}
              </div>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10.5px]" style={{ color: colors.muted }}>مقدار التغير</span>
              <div className="flex items-center gap-1">
                {dayCompare.delta != null && dayCompare.delta !== 0 && (
                  dayCompare.delta > 0 ? <TrendingDown size={11} color={colors.good} /> : <TrendingUp size={11} color={colors.bad} />
                )}
                <span className="num text-[13.5px] font-bold" style={{ color: dayCompare.delta == null ? colors.paper : dayCompare.delta > 0 ? colors.good : dayCompare.delta < 0 ? colors.bad : colors.paper }}>
                  {dayCompare.delta != null ? `${fmt(Math.abs(dayCompare.delta))} ر.س` : '—'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {projection && (
        <div style={{ background: colors.surface, borderRight: `3px solid ${projection.surplus >= 0 ? colors.good : colors.bad}` }} className="rounded-xl px-4 py-3 mt-3">
          <span className="text-[12.5px] leading-relaxed" style={{ color: colors.paper }}>
            لو صرفت بنفس معدلك الحالي (<span className="num font-bold">{fmt(projection.avgSpendRate)}</span> ر.س/يوم)،{' '}
            {projection.surplus >= 0 ? (
              <>بتوفر تقريبًا <span className="num font-bold" style={{ color: colors.good }}>{fmt(projection.surplus)}</span> ر.س آخر الدورة 🎉</>
            ) : (
              <>بتحتاج تقريبًا <span className="num font-bold" style={{ color: colors.bad }}>{fmt(Math.abs(projection.surplus))}</span> ر.س إضافية آخر الدورة</>
            )}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5 mt-3">
        <StatChipGroup items={[
          { label: 'المبلغ الأساسي', value: fmt(setup.netStart) },
          { label: 'المبلغ المتبقي', value: fmt(Math.max(0, effectiveBalance)) },
        ]} />
        <StatChipGroup items={[
          { label: 'إجمالي الاستهلاك', value: fmt(Math.max(0, setup.netStart - effectiveBalance)) },
          { label: 'أيام متبقية', value: daysRemaining },
        ]} />
      </div>

      <div className="mt-4">
        <span className="text-[12.5px] font-bold px-1" style={{ color: colors.muted }}>سجّل يومك</span>
        <div className="mt-2"><DayStrip totalDays={totalDays} todayIndex={todayIndex} checkins={checkins} selectedDay={selectedDay} openDay={openDay} cycleStartDate={parseISO(setup.cycleStart)} /></div>
        <p className="text-[11px] mt-1.5 px-1 leading-relaxed" style={{ color: colors.muted }}>
          الأيام الفاضية يعني ما سجلت رصيدك فيها — حدّك يترابط بآخر رصيد وصلنا له، فحاول ما تفوّت يوم عشان يكون حسابك دقيق
        </p>
      </div>

      <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3">
        {isEditable ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold" style={{ color: colors.paper }}>
                {isToday ? 'رصيدك اليوم' : `رصيد يوم ${selectedDay + 1}`}
                {' '}
                <span className="text-[11.5px] font-normal" style={{ color: colors.muted }}>
                  • {(() => { const d = new Date(parseISO(setup.cycleStart)); d.setDate(d.getDate() + selectedDay); return `${d.getDate()} ${MONTHS_AR[d.getMonth()]}`; })()}
                </span>
              </span>
              {selectedEntry && <Pencil size={13} color={colors.muted} />}
            </div>
            <p className="text-[12px] mt-1" style={{ color: colors.muted }}>افتح حسابك وحط كم باقي لك بالضبط — إحنا نحسب الباقي</p>
            <div className="flex gap-2 mt-3">
              <input type="number" inputMode="decimal" placeholder="0" value={entryBalance} onChange={(e) => setEntryBalance(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[15px] num w-28" />
              <input type="text" placeholder="ملاحظة (اختياري)" value={entryNote} onChange={(e) => setEntryNote(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] flex-1 min-w-0" onKeyDown={(e) => e.key === 'Enter' && saveEntry()} />
              <button onClick={saveEntry} style={{ background: justSaved ? colors.good : colors.warn, color: colors.ink }} className="rounded-xl w-11 flex items-center justify-center shrink-0" aria-label="حفظ الرصيد"><Check size={18} /></button>
            </div>
            {selectedEntry && (
              <button onClick={deleteEntry} className="text-[11px] font-bold mt-2" style={{ color: colors.bad }}>حذف تسجيل هذا اليوم</button>
            )}
            {!showExtraIncome ? (
              <button onClick={() => setShowExtraIncome(true)} className="flex items-center gap-1.5 text-[12px] font-bold mt-3" style={{ color: colors.good }}>
                <Plus size={13} />جاك دخل إضافي اليوم؟
              </button>
            ) : (
              <div style={{ background: colors.surface2 }} className="rounded-xl p-3 mt-3">
                <span className="text-[11.5px]" style={{ color: colors.muted }}>كم المبلغ الإضافي؟ (راتب ثاني، بونص، سلفة...)</span>
                <div className="flex gap-2 mt-2">
                  <input type="number" inputMode="decimal" placeholder="0" value={extraIncomeInput} onChange={(e) => setExtraIncomeInput(e.target.value)} style={{ ...inputStyle, background: colors.surface }} className="rounded-lg px-3 py-2 text-[14px] num flex-1" />
                  <button onClick={() => { setShowExtraIncome(false); setExtraIncomeInput(''); }} style={{ background: colors.surface, color: colors.muted }} className="rounded-lg w-10 flex items-center justify-center shrink-0"><X size={15} /></button>
                </div>
                {Number(extraIncomeInput) > 0 && (
                  <div className="flex items-start gap-1.5 mt-2.5">
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: colors.good, marginTop: 5 }} className="shrink-0" />
                    <span className="text-[11px] leading-relaxed" style={{ color: colors.good }}>بنضيفه تلقائيًا لرصيدك فوق - لا تحطه بخانة الرصيد. حدّك اليومي والمبلغ الأساسي يرتفعون على طول، وما بنحسب هذا اليوم "إنجاز" بالإحصائيات</span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (<span className="text-[13.5px]" style={{ color: colors.muted }}>هذا اليوم لسه ما جاء</span>)}
      </div>

      <StatsSection stats={stats} status={status} name={setup.name} baselineDaily={baselineDaily} />
      <WeekdayPatternCard stats={stats} cycleStartDate={parseISO(setup.cycleStart)} />
      <ComplianceDonut stats={stats} />
      <DailySpendChart results={stats?.results} />
      <IdealPathChart setup={setup} totalDays={totalDays} baselineDaily={baselineDaily} sortedCheckins={sortedCheckins} />
      <MonthComplianceChart cycleHistory={cycleHistory} currentStats={stats} />

      <div className="mt-4">
        <span className="text-[12.5px] font-bold px-1" style={{ color: colors.muted }}>دوراتك بالسنة</span>
        <div className="mt-2"><MonthStrip dbCycles={dbCycles} setup={setup} onViewHistory={onViewHistory} disabled={historyLoading} /></div>
      </div>

      <BillsSection bills={bills} addBill={addBill} deleteBill={deleteBill} updateBill={updateBill} paydayDom={setup.paydayDom} />
      <GoalsSection goals={goals} addGoal={addGoal} updateGoalSaved={updateGoalSaved} updateGoalDate={updateGoalDate} updateGoalTarget={updateGoalTarget} updateGoal={updateGoal} deleteGoal={deleteGoal} />
    </div>
  );
}

function HistoryDetailView({ archived, onBack, theme, toggleTheme }) {
  const colors = useColors();
  const { setup, checkins } = archived;

  const cycleStartDate = parseISO(setup.cycleStart);
  const cycleEndDate = addCycleMonths(cycleStartDate, 1, setup.paydayDom);
  const totalDays = diffDays(cycleStartDate, cycleEndDate);
  const sortedCheckins = [...checkins].sort((a, b) => a.day - b.day);
  const stats = computeStats(sortedCheckins, setup.originalNetStart ?? setup.netStart, totalDays);
  const baselineDaily = (setup.originalNetStart ?? setup.netStart) / totalDays;
  const finalBalance = sortedCheckins.length ? sortedCheckins[sortedCheckins.length - 1].balance : setup.netStart;
  const historyStatus = !stats ? 'good' : stats.complianceRate >= 70 ? 'good' : stats.complianceRate >= 40 ? 'warn' : 'bad';
  const monthNumber = cycleStartDate.getMonth() + 1;

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <h1 className="display text-[20px] font-black mb-1" style={{ color: colors.paper }}>شهر {monthNumber}</h1>
      <p className="text-[12.5px] mb-4" style={{ color: colors.muted }}>دورة خلصت — {totalDays} يوم، تبدأ يوم {setup.paydayDom} بالشهر</p>

      <div style={{ background: colors.surface }} className="rounded-2xl p-5">
        <div className="flex justify-between text-[13px] mb-3">
          <span style={{ color: colors.muted }}>المبلغ الأساسي</span>
          <span className="num font-bold" style={{ color: colors.paper }}>{fmt(setup.netStart)} ر.س</span>
        </div>
        <div className="flex justify-between text-[13px]">
          <span style={{ color: colors.muted }}>آخر رصيد بالدورة</span>
          <span className="num font-bold" style={{ color: colors.paper }}>{fmt(finalBalance)} ر.س</span>
        </div>
      </div>

      <StatsSection stats={stats} status={historyStatus} name={setup.name} baselineDaily={baselineDaily} />
      <ComplianceDonut stats={stats} />
      <DailySpendChart results={stats?.results} />
    </div>
  );
}

function CycleRolledView({ stats, name, baselineDaily, newCycleInput, setNewCycleInput, startNewCycle, theme, toggleTheme }) {
  const colors = useColors();
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };
  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div style={{ background: colors.warn }} className="w-7 h-7 rounded-full flex items-center justify-center"><Wallet size={14} color={colors.ink} /></div>
          <span className="display text-[14px] font-bold" style={{ color: colors.paper }}>المتوسط المالي</span>
        </div>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <div style={{ background: colors.surface }} className="rounded-3xl p-6 text-center">
        <Sparkles size={26} color={colors.warn} className="mx-auto" />
        <h2 className="display text-[20px] font-black mt-3" style={{ color: colors.paper }}>راتبك الجديد نزل! 🎉</h2>
        <p className="text-[13.5px] mt-2 leading-relaxed" style={{ color: colors.muted }}>خلصت دورتك السابقة. شوف كيف كان أداءك، وجهّز حدّك الجديد.</p>
      </div>

      {stats && <StatsSection stats={stats} status={stats.complianceRate >= 70 ? 'good' : stats.complianceRate >= 40 ? 'warn' : 'bad'} name={name} baselineDaily={baselineDaily} />}

      <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-3">
        <span className="text-[13px] font-bold" style={{ color: colors.paper }}>كم يبقى لك هالدورة؟</span>
        <div className="flex gap-2 mt-3">
          <input type="number" inputMode="decimal" placeholder="مثال: 3500" value={newCycleInput} onChange={(e) => setNewCycleInput(e.target.value)} style={inputStyle} className="rounded-xl px-4 py-3 text-[15px] num flex-1" />
        </div>
        <button onClick={startNewCycle} disabled={!(Number(newCycleInput) > 0)} style={{ background: Number(newCycleInput) > 0 ? colors.warn : colors.surface2, color: Number(newCycleInput) > 0 ? colors.ink : colors.muted }} className="w-full rounded-xl py-3.5 mt-3 font-bold text-[14px] display">ابدأ الدورة الجديدة</button>
      </div>
    </div>
  );
}

function SettingsView({ setup, onBack, onInstallGuide, onAbout, onFaq, onGuide, onUpdateSetup, confirmReset, setConfirmReset, resetAll, onLogout }) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(setup.name || '');
  const [editNet, setEditNet] = useState(String(setup.netStart));
  const [editPayday, setEditPayday] = useState(String(setup.paydayDom));
  const [shareState, setShareState] = useState('idle'); // 'idle' | 'copied' | 'manual'
  const [rateNote, setRateNote] = useState(false);
  const shareInputRef = useRef(null);
  const inputStyle = { background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` };

  function startEdit() {
    setEditName(setup.name || ''); setEditNet(String(setup.netStart)); setEditPayday(String(setup.paydayDom));
    setEditing(true);
  }
  function saveEdit() {
    const p = Number(editPayday);
    onUpdateSetup({
      name: editName.trim(),
      netStart: Number(editNet),
      paydayDom: p >= 1 && p <= 31 ? p : undefined,
    });
    setEditing(false);
  }

  const inviteText = 'جرب نظرية المتوسط المالي - تدخل رقم واحد بس (كم باقي معك) وهو يحسب لك حدّك اليومي تلقائي 💪';

  async function shareApp() {
    try {
      if (navigator.share) { await navigator.share({ text: inviteText }); return; }
      throw new Error('no share api');
    } catch (e) {
      try {
        await navigator.clipboard.writeText(inviteText);
        setShareState('copied'); setTimeout(() => setShareState('idle'), 1800);
      } catch (e2) {
        setShareState('manual');
        setTimeout(() => { shareInputRef.current?.focus(); shareInputRef.current?.select(); }, 50);
      }
    }
  }

  return (
    <div className="float-in">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5" style={{ color: colors.muted }}><ArrowRight size={16} /><span className="text-[14px]">رجوع</span></button>
      </div>
      <div className="flex items-center justify-between">
        <h2 className="display text-[20px] font-black" style={{ color: colors.paper }}>الإعدادات</h2>
        {!editing && (
          <button onClick={startEdit} className="flex items-center gap-1 text-[12px] font-bold" style={{ color: colors.warn }}><Pencil size={12} />تعديل</button>
        )}
      </div>

      {!editing ? (
        <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-4 flex flex-col gap-3">
          {setup.name && (
            <div className="flex justify-between text-[14px]"><span style={{ color: colors.muted }}>الاسم</span><span style={{ color: colors.paper }}>{setup.name}</span></div>
          )}
          <div className="flex justify-between text-[14px]"><span style={{ color: colors.muted }}>المبلغ المتبقي الأساسي</span><span className="num" style={{ color: colors.paper }}>{fmt(setup.netStart)} ر.س</span></div>
          <div className="flex justify-between text-[14px]"><span style={{ color: colors.muted }}>يوم نزول الراتب</span><span className="num" style={{ color: colors.paper }}>يوم {setup.paydayDom}</span></div>
          {setup.commitments && setup.commitments.length > 0 && (
            <>
              <div className="h-px" style={{ background: colors.line }} />
              {setup.salaryUsed && (
                <div className="flex justify-between text-[14px]"><span style={{ color: colors.muted }}>الراتب المستخدم بالحساب</span><span className="num" style={{ color: colors.paper }}>{fmt(setup.salaryUsed)} ر.س</span></div>
              )}
              <span className="text-[12.5px]" style={{ color: colors.muted }}>الالتزامات اللي احتسبناها</span>
              {setup.commitments.map((c) => (
                <div key={c.id} className="flex justify-between text-[13.5px]">
                  <span style={{ color: colors.paper }}>{c.name}</span>
                  <span className="num" style={{ color: colors.muted }}>{fmt(c.amount)} ر.س</span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div style={{ background: colors.surface }} className="rounded-2xl p-4 mt-4 flex flex-col gap-3">
          <Field label="الاسم">
            <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px]" />
          </Field>
          <Field label="المبلغ المتبقي الأساسي">
            <input type="number" inputMode="decimal" value={editNet} onChange={(e) => setEditNet(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
          </Field>
          <Field label="يوم نزول الراتب">
            <input type="number" inputMode="numeric" min="1" max="31" value={editPayday} onChange={(e) => setEditPayday(e.target.value)} style={inputStyle} className="rounded-xl px-3 py-2.5 text-[14px] num" />
          </Field>
          <p className="text-[11px] leading-relaxed" style={{ color: colors.muted }}>تعديل يوم الراتب أو المبلغ يأثر على حساباتك بالدورة الحالية مباشرة - استخدمها بس لتصحيح خطأ، مو لتغيير الخطة بعد ما تبدأ</p>
          <div className="flex gap-2 mt-1">
            <button onClick={saveEdit} className="flex-1 rounded-xl py-2.5 text-[13.5px] font-bold" style={{ background: colors.warn, color: colors.ink }}>حفظ</button>
            <button onClick={() => setEditing(false)} className="flex-1 rounded-xl py-2.5 text-[13.5px]" style={{ background: colors.surface2, color: colors.paper }}>إلغاء</button>
          </div>
        </div>
      )}
      <div className="mt-4">
        <button onClick={onInstallGuide} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.warn, color: colors.ink }}>📲 ثبّت الموقع كتطبيق</button>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        <button onClick={onAbout} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}><Info size={16} />من نحن</button>
        <button onClick={onFaq} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}><HelpCircle size={16} />الأسئلة الشائعة</button>
        <button onClick={onGuide} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}><BookOpen size={16} />دليل استخدام التطبيق</button>

        <div className="h-px my-1" style={{ background: colors.line }} />

        <button onClick={shareApp} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}>
          {shareState === 'copied' ? <Check size={16} color={colors.good} /> : <Share2 size={16} />}
          {shareState === 'copied' ? 'تم النسخ!' : 'شارك مع الأصدقاء'}
        </button>
        {shareState === 'manual' && (
          <div style={{ background: colors.surface }} className="rounded-xl p-3">
            <span className="text-[11.5px]" style={{ color: colors.muted }}>حدد النص وانسخه يدويًا:</span>
            <input ref={shareInputRef} readOnly value={inviteText} onFocus={(e) => e.target.select()} style={{ background: colors.surface2, color: colors.paper, border: `1px solid ${colors.line}` }} className="w-full rounded-lg px-3 py-2.5 text-[12.5px] mt-2" />
          </div>
        )}

        <button onClick={() => setRateNote(!rateNote)} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}>⭐ قيّم التطبيق</button>
        {rateNote && (
          <div style={{ background: colors.surface }} className="rounded-xl p-3">
            <span className="text-[12px] leading-relaxed" style={{ color: colors.muted }}>هذا الخيار بيصير فعّال بعد نشر التطبيق على المتجر</span>
          </div>
        )}

        <a href="mailto:support@example.com" className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}>✉️ تواصل مع فريق الدعم</a>

        <button onClick={onLogout} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.paper }}><LogOut size={16} />تسجيل خروج</button>

        <div className="h-px my-1" style={{ background: colors.line }} />

        {!confirmReset ? (
          <button onClick={() => setConfirmReset(true)} className="w-full rounded-2xl py-3.5 flex items-center justify-center gap-2 text-[14px] font-bold" style={{ background: colors.surface, color: colors.bad }}><RotateCcw size={16} />بدء من جديد (يمسح كل البيانات)</button>
        ) : (
          <div style={{ background: colors.surface }} className="rounded-2xl p-4">
            <p className="text-[13.5px] leading-relaxed" style={{ color: colors.paper }}>متأكد؟ راح تنمسح كل بياناتك الحالية ولازم تبدأ من جديد.</p>
            <div className="flex gap-2 mt-3">
              <button onClick={resetAll} className="flex-1 rounded-xl py-2.5 text-[13.5px] font-bold" style={{ background: colors.bad, color: colors.ink }}>نعم، امسح</button>
              <button onClick={() => setConfirmReset(false)} className="flex-1 rounded-xl py-2.5 text-[13.5px]" style={{ background: colors.surface2, color: colors.paper }}>تراجع</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

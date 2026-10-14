// CrewBus M5 Launch screen — multi-harness & model chips, brief, preview & live. JSX: not `node --check`ed.
import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconZap, IconLaunch } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

const PERMS = ['supervised', 'autoEdits', 'auto', 'full'];
const MODELS = [{ id: '', l: 'Default' }, { id: 'claude-3-7-sonnet', l: '3.7 Sonnet' }, { id: 'gemini-2.5-pro', l: 'Gemini 2.5' }, { id: 'o3-mini', l: 'o3-mini' }, { id: 'grok-3', l: 'Grok 3' }];


export function LaunchScreen({ ctx, navigation }) {
  const { T, S } = useStyles();
  const styles = React.useMemo(() => StyleSheet.create({
  chip: { backgroundColor: T.cardElevated, borderWidth: 1, borderColor: T.border, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6 },
  chipSel: { borderColor: T.primary, backgroundColor: T.primaryMuted },
  chipText: { color: T.textMuted, fontSize: 11, fontWeight: '600' },
  chipTextSel: { color: T.text, fontWeight: '700' },
  modelChip: { backgroundColor: T.cardElevated, borderWidth: 1, borderColor: T.border, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, marginRight: 6 }, modelChipSel: { borderColor: T.amber, backgroundColor: T.amberMuted },
  modelText: { color: T.textSubtle, fontSize: 10, fontWeight: '600' }, modelTextSel: { color: T.amber, fontWeight: '700' },
  stepBtn: { backgroundColor: T.cardElevated, borderWidth: 1, borderColor: T.border, borderRadius: 6, width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  permChip: { paddingHorizontal: 5, paddingVertical: 3, borderRadius: 6, backgroundColor: T.cardElevated, borderWidth: 1, borderColor: T.border },
  permChipSel: { borderColor: T.emerald, backgroundColor: T.emeraldMuted },
  permText: { color: T.textSubtle, fontSize: 9, fontWeight: '600' },
  permTextSel: { color: T.emerald, fontWeight: '700' },
  briefInput: { backgroundColor: T.cardElevated, borderWidth: 1, borderColor: T.border, borderRadius: 8, padding: 8, color: T.text, minHeight: 75, textAlignVertical: 'top', fontSize: 12 },
  }), [T]);
  const [harnesses, setHarnesses] = React.useState([]);
  const [selected, setSelected] = React.useState(['claude']);
  const [model, setModel] = React.useState('');
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [preview, setPreview] = React.useState(null);
  const [status, setStatus] = React.useState('Configure multi-harness launch & preview.');

  const currentApi = () => {
    const route = ctx.connection.getState().route;
    if (!route) throw new Error('no route connected — connect in Hub');
    return ctx.apiFor(route);
  };

  const loadHarnesses = async () => {
    try {
      const data = await currentApi().fetchHarnesses();
      const list = Array.isArray(data) ? data : data.harnesses || data.items || [];
      setHarnesses(list);
      setStatus(`${list.length} harnesses available`);
    } catch { setStatus('offline — harness detection failed'); }
  };

  React.useEffect(() => { loadHarnesses().catch(() => null); }, []);

  const toggleHarness = (d) => {
    setSelected((prev) => {
      const next = prev.includes(d) ? (prev.length > 1 ? prev.filter((x) => x !== d) : prev) : [...prev, d];
      setCount(next.length);
      return next;
    });
  };

  const payload = () => ({ from: 'mobile', token: '', harness: selected.join(','), harnesses: selected, model: model || undefined, count, body: brief, permission });

  const doPreview = async () => {
    try { setPreview(await currentApi().launch(payload())); setStatus('Dry-run preview ready.'); }
    catch (e) { setStatus(`preview failed: ${String((e && e.message) || e)}`); }
  };

  const doLive = async () => {
    try {
      const res = await currentApi().launch({ ...payload(), dryRun: false });
      setStatus(`Launched: ${res.crewId || res.batch || (res.workers && res.workers.length + ' workers') || 'ok'}`);
      setPreview(null);
    } catch (e) { setStatus(`launch failed: ${String((e && e.message) || e)}`); }
  };

  const harnessList = harnesses.length ? harnesses : [{ name: 'claude' }, { name: 'antigravity' }, { name: 'codex' }, { name: 'grok' }, { name: 'generic' }];

  return (
    <View style={S.screen}>
      <HeaderBar title="Launch Task" statusText={status} navigation={navigation} rightTitle="Detect" onRightPress={loadHarnesses} />
      <ScrollView style={S.body} contentContainerStyle={{ gap: 8, paddingBottom: 20 }}>
        <FlatList horizontal showsHorizontalScrollIndicator={false} data={harnessList} keyExtractor={(h, i) => String(h.driver || h.name || i)}
          renderItem={({ item }) => {
            const d = String(item.driver || item.name); const isSel = selected.includes(d);
            return (<TouchableOpacity style={[styles.chip, isSel && styles.chipSel]} onPress={() => toggleHarness(d)}><Text style={[styles.chipText, isSel && styles.chipTextSel]}>{d}</Text></TouchableOpacity>);
          }}
        />
        <FlatList horizontal showsHorizontalScrollIndicator={false} data={MODELS} keyExtractor={(m) => m.id || 'def'}
          renderItem={({ item }) => (<TouchableOpacity style={[styles.modelChip, model === item.id && styles.modelChipSel]} onPress={() => setModel(item.id)}><Text style={[styles.modelText, model === item.id && styles.modelTextSel]}>{item.l}</Text></TouchableOpacity>)}
        />
        <View style={S.row}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.max(1, c - 1))}><Text style={S.btnText}>-</Text></TouchableOpacity>
          <Text style={S.text}>Workers: {count}</Text>
          <TouchableOpacity style={styles.stepBtn} onPress={() => setCount((c) => Math.min(20, c + 1))}><Text style={S.btnText}>+</Text></TouchableOpacity>
          <View style={{ flex: 1, flexDirection: 'row', gap: 4, justifyContent: 'flex-end' }}>
            {PERMS.map((p) => (<TouchableOpacity key={p} style={[styles.permChip, p === permission && styles.permChipSel]} onPress={() => setPermission(p)}><Text style={[styles.permText, p === permission && styles.permTextSel]}>{p}</Text></TouchableOpacity>))}
          </View>
        </View>
        <TextInput style={styles.briefInput} value={brief} onChangeText={setBrief} placeholder="Task instructions (Ctrl+Enter to launch)…" placeholderTextColor={T.textSubtle} multiline numberOfLines={3} />
        <TouchableOpacity style={S.btnSecondary} disabled={!brief.trim()} onPress={doPreview}><Text style={S.btnText}>Preview Dry-Run</Text></TouchableOpacity>
        {preview && (
          <View style={[S.card, { borderColor: T.primary, gap: 6 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><IconZap size={14} color={T.primaryLight} /><Text style={{ color: T.primaryLight, fontSize: 12, fontWeight: '700' }}>Dry-Run Summary</Text></View>
            <Text style={S.cardSub}>{preview.summary || `${count} worker(s) ready [${selected.join(', ')}]`}</Text>
            <TouchableOpacity style={[S.btnPrimary, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }]} onPress={doLive}>
              <IconLaunch size={15} color={T.onPrimary} /><Text style={S.btnPrimaryText}>Confirm LIVE Launch</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      <BottomNav currentRoute={ROUTES.Launch} navigation={navigation} />
    </View>
  );
}


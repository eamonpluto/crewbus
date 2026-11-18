// CrewBus M5 Launch screen — harness-specific model chips, brief & direct live launch.
import React from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconLaunch } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

const PERMS = ['supervised', 'autoEdits', 'auto', 'full'];

// Canonical model catalog per harness matching crewbus web (HARNESS_MODELS).
// Serves as immediate offline catalog and fallback while dynamic discovery enriches it.
export const HARNESS_MODELS = {
  opencode: [
    { id: '', label: 'Default' },
    { id: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'opencode/claude-opus-5', label: 'Claude Opus 5' },
    { id: 'opencode/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'opencode/gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'opencode/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'opencode/gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'opencode/deepseek-v4-pro', label: 'DeepSeek v4 Pro' },
    { id: 'opencode/grok-4.7', label: 'Grok 4.7' },
    { id: 'opencode-go/claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
    { id: 'anthropic/claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
    { id: 'openai/o3-mini', label: 'o3-mini' },
  ],
  claude: [
    { id: '', label: 'Default' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
  ],
  antigravity: [
    { id: '', label: 'Default' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  codex: [
    { id: '', label: 'Default' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'o3-mini', label: 'o3-mini' },
    { id: 'o1', label: 'o1' },
  ],
  grok: [
    { id: '', label: 'Default' },
    { id: 'grok-4.7', label: 'Grok 4.7' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.3', label: 'Grok 4.3' },
    { id: 'grok-3', label: 'Grok 3' },
  ],
  cursor: [
    { id: '', label: 'Default' },
    { id: 'cursor/grok-4.7', label: 'Grok 4.7' },
    { id: 'cursor/composer', label: 'Cursor Composer' },
    { id: 'cursor/claude-opus-5', label: 'Claude Opus 5' },
    { id: 'cursor/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'cursor/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'cursor/gpt-5.5', label: 'GPT-5.5' },
  ],
  qwen: [
    { id: '', label: 'Default' },
    { id: 'qwen3.8-max', label: 'Qwen 3.8 Max' },
    { id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' },
    { id: 'qwen3.8-flash', label: 'Qwen 3.8 Flash' },
    { id: 'deepseek-v4-pro-0813', label: 'DeepSeek v4 Pro' },
  ],
};

const DEF_HARNESSES = [
  { driver: 'opencode' },
  { driver: 'claude' },
  { driver: 'antigravity' },
  { driver: 'codex' },
  { driver: 'grok' },
  { driver: 'cursor' },
  { driver: 'qwen' },
];

export function LaunchScreen({ ctx, navigation, route }) {
  const { T, S } = useStyles();

  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        sectionLabel: {
          color: T.textSubtle,
          fontSize: 11,
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginTop: 4,
          marginBottom: 2,
        },
        chip: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 16,
          paddingHorizontal: 12,
          paddingVertical: 6,
          marginRight: 6,
        },
        chipSel: {
          borderColor: T.primary,
          backgroundColor: T.primaryMuted,
        },
        chipText: {
          color: T.textMuted,
          fontSize: 12,
          fontWeight: '600',
        },
        chipTextSel: {
          color: T.text,
          fontWeight: '700',
        },
        modelChip: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 12,
          paddingHorizontal: 10,
          paddingVertical: 5,
          marginRight: 6,
        },
        modelChipSel: {
          borderColor: T.amber,
          backgroundColor: T.amberMuted,
        },
        modelText: {
          color: T.textSubtle,
          fontSize: 11,
          fontWeight: '600',
        },
        modelTextSel: {
          color: T.amber,
          fontWeight: '700',
        },
        stepBtn: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 6,
          width: 30,
          height: 30,
          alignItems: 'center',
          justifyContent: 'center',
        },
        permChip: {
          paddingHorizontal: 7,
          paddingVertical: 4,
          borderRadius: 6,
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
        },
        permChipSel: {
          borderColor: T.emerald,
          backgroundColor: T.emeraldMuted,
        },
        permText: {
          color: T.textSubtle,
          fontSize: 10,
          fontWeight: '600',
        },
        permTextSel: {
          color: T.emerald,
          fontWeight: '700',
        },
        briefInput: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 8,
          padding: 10,
          color: T.text,
          minHeight: 90,
          textAlignVertical: 'top',
          fontSize: 13,
        },
        launchBtn: {
          backgroundColor: T.primary,
          borderRadius: 10,
          paddingVertical: 14,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          marginTop: 4,
        },
        launchBtnDisabled: {
          opacity: 0.5,
        },
        launchBtnText: {
          color: T.onPrimary,
          fontSize: 14,
          fontWeight: '700',
        },
      }),
    [T],
  );

  const [harnesses, setHarnesses] = React.useState([]);
  const [catalog, setCatalog] = React.useState(null);
  const [selectedHarness, setSelectedHarness] = React.useState('opencode');
  const [model, setModel] = React.useState('');
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [launching, setLaunching] = React.useState(false);
  const [status, setStatus] = React.useState('Configure launch.');

  const currentApi = () =>
    ctx.getApi ? ctx.getApi() : ctx.apiFor(ctx.connection.getState().route);

  const loadHarnesses = async () => {
    try {
      const api = currentApi();
      const [hData, mData] = await Promise.all([
        api.fetchHarnesses().catch(() => null),
        api.fetchModels ? api.fetchModels().catch(() => null) : null,
      ]);

      if (hData) {
        const list = Array.isArray(hData) ? hData : hData.harnesses || hData.items || [];
        setHarnesses(list);
        const found = list
          .filter((h) => h.found === true)
          .map((h) => String(h.driver || h.name));
        if (found.length > 0 && !found.includes(selectedHarness)) {
          setSelectedHarness(found[0]);
          setModel('');
        }
        setStatus(`${list.length} harnesses (${found.length} installed)`);
      }

      if (mData && typeof mData === 'object') {
        setCatalog(mData);
      }
    } catch (e) {
      setStatus(`offline — ${String((e && e.message) || 'check relay')}`);
    }
  };

  React.useEffect(() => {
    loadHarnesses().catch(() => null);
  }, []);

  const handleSelectHarness = (d) => {
    setSelectedHarness(d);
    // Reset model on harness switch so incompatible model IDs are not retained
    setModel('');
  };

  const doLaunch = async () => {
    if (!brief.trim() || launching) return;
    setLaunching(true);
    setStatus('Launching agents…');
    try {
      const api = currentApi();
      const res = await api.launch({
        from: 'mobile',
        token: '',
        harness: selectedHarness,
        harnesses: [selectedHarness],
        model: model || undefined,
        count,
        body: brief,
        permission,
        dryRun: false,
      });
      const names = res.workers ? res.workers.map((w) => w.name).join(', ') : '';
      setStatus(`Launched: ${names || res.crewId || res.batch || 'ok'}`);
      setBrief('');
      if (navigation) {
        navigation.navigate(ROUTES.Briefs);
      }
    } catch (e) {
      setStatus(`launch failed: ${String((e && e.message) || e)}`);
    } finally {
      setLaunching(false);
    }
  };

  React.useEffect(() => {
    if (route && route.params && route.params.initialPrompt) {
      setBrief(route.params.initialPrompt);
    }
  }, [route]);

  const harnessList = harnesses.length ? harnesses : DEF_HARNESSES;

  // Compute models specific to the selected harness
  const modelsList = React.useMemo(() => {
    const baseList = HARNESS_MODELS[selectedHarness] || [{ id: '', label: 'Default' }];
    const items = [...baseList];
    if (catalog && Array.isArray(catalog[selectedHarness])) {
      const existing = new Set(items.map((m) => m.id));
      for (const m of catalog[selectedHarness]) {
        if (!existing.has(m.id)) {
          const l = (m.label || m.id).split('(')[0].trim().slice(0, 22);
          items.push({ id: m.id, label: l });
          existing.add(m.id);
        }
      }
    }
    return items;
  }, [catalog, selectedHarness]);

  return (
    <View style={S.screen}>
      <HeaderBar
        title="Launch Task"
        statusText={status}
        navigation={navigation}
        rightTitle="Detect"
        onRightPress={loadHarnesses}
      />
      <ScrollView
        style={S.body}
        contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
      >
        <Text style={styles.sectionLabel}>Harness</Text>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={harnessList}
          keyExtractor={(h, i) => String(h.driver || h.name || i)}
          renderItem={({ item }) => {
            const d = String(item.driver || item.name);
            const isSel = selectedHarness === d;
            const isFound = item.found === true;
            return (
              <TouchableOpacity
                style={[styles.chip, isSel && styles.chipSel]}
                onPress={() => handleSelectHarness(d)}
              >
                <Text style={[styles.chipText, isSel && styles.chipTextSel]}>
                  {isFound ? '● ' : ''}
                  {d}
                </Text>
              </TouchableOpacity>
            );
          }}
        />

        <Text style={styles.sectionLabel}>
          Model ({selectedHarness})
        </Text>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={modelsList}
          keyExtractor={(m) => m.id || 'def'}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.modelChip,
                model === item.id && styles.modelChipSel,
              ]}
              onPress={() => setModel(item.id)}
            >
              <Text
                style={[
                  styles.modelText,
                  model === item.id && styles.modelTextSel,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />

        <View style={[S.row, { marginTop: 4 }]}>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => setCount((c) => Math.max(1, c - 1))}
          >
            <Text style={S.btnText}>-</Text>
          </TouchableOpacity>
          <Text style={[S.text, { fontWeight: '700' }]}>Workers: {count}</Text>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => setCount((c) => Math.min(20, c + 1))}
          >
            <Text style={S.btnText}>+</Text>
          </TouchableOpacity>
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              gap: 4,
              justifyContent: 'flex-end',
            }}
          >
            {PERMS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.permChip, p === permission && styles.permChipSel]}
                onPress={() => setPermission(p)}
              >
                <Text
                  style={[
                    styles.permText,
                    p === permission && styles.permTextSel,
                  ]}
                >
                  {p}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TextInput
          style={styles.briefInput}
          value={brief}
          onChangeText={setBrief}
          placeholder="Task instructions for agents…"
          placeholderTextColor={T.textSubtle}
          multiline
          numberOfLines={3}
        />

        <TouchableOpacity
          style={[
            styles.launchBtn,
            (!brief.trim() || launching) && styles.launchBtnDisabled,
          ]}
          disabled={!brief.trim() || launching}
          onPress={doLaunch}
        >
          {launching ? (
            <ActivityIndicator size="small" color={T.onPrimary} />
          ) : (
            <IconLaunch size={18} color={T.onPrimary} />
          )}
          <Text style={styles.launchBtnText}>
            {launching ? 'Launching Agents…' : 'Launch Agents'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
      <BottomNav currentRoute={ROUTES.Launch} navigation={navigation} />
    </View>
  );
}

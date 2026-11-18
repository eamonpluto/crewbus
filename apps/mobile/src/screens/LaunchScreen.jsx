// CrewBus M5 Launch screen — multi-harness & model chips, brief, preview & live.
import React from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useStyles } from '../theme.js';
import { HeaderBar } from '../components/HeaderBar.jsx';
import { BottomNav } from '../components/BottomNav.jsx';
import { IconZap, IconLaunch } from '../components/Icons.jsx';
import { ROUTES } from '../navigation/routes.js';

const PERMS = ['supervised', 'autoEdits', 'auto', 'full'];

const DEF_MODELS = [
  { id: '', l: 'Default' },
  { id: 'claude-sonnet-5-5', l: 'Sonnet 5.5' },
  { id: 'gemini-3.8-flash', l: 'Gemini 3.8' },
  { id: 'gpt-6.1-sol', l: 'GPT-6.1' },
  { id: 'grok-4.7', l: 'Grok 4.7' },
  { id: 'deepseek-v4-pro', l: 'DeepSeek v4' },
  { id: 'claude-opus-5-5', l: 'Opus 5.5' },
];

const DEF_HARNESSES = [
  { driver: 'opencode' },
  { driver: 'claude' },
  { driver: 'antigravity' },
  { driver: 'codex' },
  { driver: 'grok' },
  { driver: 'cursor' },
];

export function LaunchScreen({ ctx, navigation }) {
  const { T, S } = useStyles();

  const styles = React.useMemo(
    () =>
      StyleSheet.create({
        chip: {
          backgroundColor: T.cardElevated,
          borderWidth: 1,
          borderColor: T.border,
          borderRadius: 16,
          paddingHorizontal: 10,
          paddingVertical: 5,
          marginRight: 6,
        },
        chipSel: {
          borderColor: T.primary,
          backgroundColor: T.primaryMuted,
        },
        chipText: {
          color: T.textMuted,
          fontSize: 11,
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
          paddingHorizontal: 8,
          paddingVertical: 4,
          marginRight: 6,
        },
        modelChipSel: {
          borderColor: T.amber,
          backgroundColor: T.amberMuted,
        },
        modelText: {
          color: T.textSubtle,
          fontSize: 10,
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
          width: 26,
          height: 26,
          alignItems: 'center',
          justifyContent: 'center',
        },
        permChip: {
          paddingHorizontal: 5,
          paddingVertical: 3,
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
          fontSize: 9,
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
          padding: 8,
          color: T.text,
          minHeight: 75,
          textAlignVertical: 'top',
          fontSize: 12,
        },
      }),
    [T],
  );

  const [harnesses, setHarnesses] = React.useState([]);
  const [catalog, setCatalog] = React.useState(null);
  const [selected, setSelected] = React.useState(['opencode']);
  const [model, setModel] = React.useState('');
  const [count, setCount] = React.useState(1);
  const [brief, setBrief] = React.useState('');
  const [permission, setPermission] = React.useState('supervised');
  const [preview, setPreview] = React.useState(null);
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
        if (found.length > 0 && selected.every((s) => !found.includes(s))) {
          setSelected([found[0]]);
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

  const toggleHarness = (d) =>
    setSelected((prev) => {
      const next = prev.includes(d)
        ? prev.length > 1
          ? prev.filter((x) => x !== d)
          : prev
        : [...prev, d];
      setCount(next.length);
      return next;
    });

  const payload = () => ({
    from: 'mobile',
    token: '',
    harness: selected.join(','),
    harnesses: selected,
    model: model || undefined,
    count,
    body: brief,
    permission,
  });

  const doPreview = async () => {
    try {
      setPreview(await currentApi().launch(payload()));
      setStatus('Dry-run preview ready.');
    } catch (e) {
      setStatus(`preview failed: ${String((e && e.message) || e)}`);
    }
  };

  const doLive = async () => {
    try {
      const res = await currentApi().launch({ ...payload(), dryRun: false });
      setStatus(
        `Launched: ${
          res.crewId ||
          res.batch ||
          (res.workers && res.workers.length + ' workers') ||
          'ok'
        }`,
      );
      setPreview(null);
    } catch (e) {
      setStatus(`launch failed: ${String((e && e.message) || e)}`);
    }
  };

  const harnessList = harnesses.length ? harnesses : DEF_HARNESSES;

  const modelsList = React.useMemo(() => {
    if (!catalog) return DEF_MODELS;
    const items = [{ id: '', l: 'Default' }];
    for (const h of selected) {
      for (const m of catalog[h] || []) {
        if (!items.some((x) => x.id === m.id)) {
          items.push({
            id: m.id,
            l: (m.label || m.id).split('(')[0].trim().slice(0, 18),
          });
        }
      }
    }
    return items.length > 1 ? items : DEF_MODELS;
  }, [catalog, selected]);

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
        contentContainerStyle={{ gap: 8, paddingBottom: 20 }}
      >
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={harnessList}
          keyExtractor={(h, i) => String(h.driver || h.name || i)}
          renderItem={({ item }) => {
            const d = String(item.driver || item.name);
            const isSel = selected.includes(d);
            const isFound = item.found === true;
            return (
              <TouchableOpacity
                style={[styles.chip, isSel && styles.chipSel]}
                onPress={() => toggleHarness(d)}
              >
                <Text style={[styles.chipText, isSel && styles.chipTextSel]}>
                  {isFound ? '● ' : ''}
                  {d}
                </Text>
              </TouchableOpacity>
            );
          }}
        />

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
                {item.l}
              </Text>
            </TouchableOpacity>
          )}
        />

        <View style={S.row}>
          <TouchableOpacity
            style={styles.stepBtn}
            onPress={() => setCount((c) => Math.max(1, c - 1))}
          >
            <Text style={S.btnText}>-</Text>
          </TouchableOpacity>
          <Text style={S.text}>Workers: {count}</Text>
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
          placeholder="Task instructions (Ctrl+Enter to launch)…"
          placeholderTextColor={T.textSubtle}
          multiline
          numberOfLines={3}
        />

        <TouchableOpacity
          style={S.btnSecondary}
          disabled={!brief.trim()}
          onPress={doPreview}
        >
          <Text style={S.btnText}>Preview Dry-Run</Text>
        </TouchableOpacity>

        {preview && (
          <View style={[S.card, { borderColor: T.primary, gap: 6 }]}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <IconZap size={14} color={T.primaryLight} />
              <Text
                style={{
                  color: T.primaryLight,
                  fontSize: 12,
                  fontWeight: '700',
                }}
              >
                Dry-Run Summary
              </Text>
            </View>
            <Text style={S.cardSub}>
              {preview.summary ||
                `${count} worker(s) ready [${selected.join(', ')}]`}
            </Text>
            <TouchableOpacity
              style={[
                S.btnPrimary,
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                },
              ]}
              onPress={doLive}
            >
              <IconLaunch size={15} color={T.onPrimary} />
              <Text style={S.btnPrimaryText}>Confirm LIVE Launch</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      <BottomNav currentRoute={ROUTES.Launch} navigation={navigation} />
    </View>
  );
}

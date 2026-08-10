# review-swarm

PR이 열리거나 새 커밋이 올라오면, **로컬에 이미 설치·결제된 Claude Code / Codex CLI**로 멀티에이전트 코드 리뷰를 돌리고, 각 전문 에이전트가 **자기 이름의 GitHub App 봇으로 실제 PR 인라인 리뷰**를 남긴다.

API 키를 따로 사지 않는다. self-hosted 러너에서 `claude -p`와 `codex exec`를 그대로 호출한다.

```
GitHub PR (opened / synchronize)
        │
        ▼
Self-hosted GitHub Actions Runner
        │
        ▼
Review Orchestrator
   ├─ Blackboard 구성 (PR diff / 관련 코드 / 테스트·정적분석 / 팀 규칙)
   ├─ Router가 변경 성격에 맞는 전문가만 선택          ← 결정론적, 모델 미사용
   └─ 전문가 병렬 실행 (읽기 전용 샌드박스)
        ├─ 🛡️ Security Sentinel      (안전 게이트)
        ├─ 🧮 Consistency Guardian   (안전 게이트)
        ├─ ⚡ Performance Analyst     (전문 분석가)
        ├─ 🏛️ Architect              (가치)
        ├─ 🎯 Pragmatist             (가치)
        └─ 🤝 Collaborator           (가치)
                │
        Structured Findings (JSON 스키마 강제)
                │
        Dedup → 적대적 Verify (반박 담당 검증관)
                │
        충돌한 쌍만 선택적 Debate
                │
        ⚖️ Mediator — REQUEST_CHANGE / SUGGESTION / FOLLOW_UP / QUESTION / DROP
                │
        Deterministic Policy Gate                      ← 여기만이 머지를 막는다
                │
        GitHub PR Review (에이전트별 봇 계정으로 인라인 게시)
```

## 권한 모델

에이전트마다 판정 권한이 다르다. 이건 프롬프트가 아니라 [`src/pipeline/policy.ts`](src/pipeline/policy.ts)의 결정론적 코드로 강제된다.

| 계층 | 에이전트 | 권한 |
| --- | --- | --- |
| 안전 게이트 | `security`, `consistency` | 심각도 `high` 이상 + 확신도 0.7 이상 + 검증 통과면 **조정자 판정을 덮고 REQUEST_CHANGE로 상향**한다 |
| 전문 분석가 | `performance` | 규모·측정 근거(숫자가 포함된 구체적 조건)가 있을 때만 차단. 없으면 자동으로 SUGGESTION으로 하향 |
| 가치 에이전트 | `architect`, `pragmatist`, `collaborator` | **절대 차단하지 못한다.** REQUEST_CHANGE를 내도 SUGGESTION으로 하향된다 |

모든 상향/하향은 요약 코멘트의 "정책 게이트 조정 내역"에 기록된다.

## 요구 사항

- Node.js >= 20.19
- git
- `claude` (Claude Code CLI) 또는 `codex` (Codex CLI) — **러너 사용자 계정으로 이미 로그인되어 있어야 한다**
- self-hosted GitHub Actions 러너

```bash
node dist/cli.js doctor
```

로 Node 버전, git, 엔진 실행 가능 여부, 토큰, App 자격을 한 번에 점검할 수 있다.

## 다른 저장소에 붙이기

### 1. 이 도구를 저장소에 둔다

권장: 이 `review-swarm/` 디렉터리를 별도 저장소(예: `your-org/review-swarm`)로 올린다. 그러면 다른 저장소에서 `uses: your-org/review-swarm@main`으로 참조한다.

### 2. 대상 저장소에 설정과 워크플로를 생성한다

```bash
node /path/to/review-swarm/dist/cli.js init --workdir /path/to/target-repo
```

- `.review-swarm.yaml` — 설정 (전부 선택 사항, 없으면 내장 기본값)
- `.github/workflows/review-swarm.yml` — 워크플로 템플릿
- `.gitignore`에 `.review-swarm/` 추가

생성된 워크플로에서 `uses: ORG/REPO/review-swarm@main`을 실제 경로로 바꾼다.

### 3. 러너를 준비한다

러너에 `[self-hosted, review-swarm]` 라벨을 붙이고, **러너를 실행하는 그 사용자 계정으로** 엔진에 로그인한다.

```bash
claude setup-token     # Claude 구독 사용
codex login            # ChatGPT 구독 사용
```

러너가 systemd/launchd 서비스로 돌면 `HOME`이 로그인한 사용자와 같아야 한다. 다르면 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`을 러너 환경에 지정한다.

### 4. 에이전트별 GitHub App을 만든다

7개(또는 쓰려는 개수만큼) App을 만든다. 이름이 곧 PR에 보이는 봇 이름이 된다.

**Settings → Developer settings → GitHub Apps → New GitHub App**

| 항목 | 값 |
| --- | --- |
| GitHub App name | `Security Sentinel`, `Consistency Guardian`, `Performance Analyst`, `Architect`, `Pragmatist`, `Collaborator`, `Review Mediator` |
| Homepage URL | 아무 URL (예: 저장소 주소) |
| Webhook | **Active 체크 해제** (웹훅을 받지 않는다) |
| Repository permissions → Pull requests | **Read and write** |
| Repository permissions → Contents | Read-only |
| Where can this be installed | Only on this account |

만든 뒤 각 App에서:

1. **Generate a private key** → `.pem` 파일 다운로드
2. **Install App** → 리뷰할 저장소에 설치
3. App ID 기록

### 5. 시크릿을 등록한다

대상 저장소의 **Settings → Secrets and variables → Actions**에 등록한다. 이름 규칙은 `SWARM_<에이전트ID 대문자>_APP_ID` / `_PRIVATE_KEY`다.

| 에이전트 | 시크릿 |
| --- | --- |
| `security` | `SWARM_SECURITY_APP_ID`, `SWARM_SECURITY_PRIVATE_KEY` |
| `consistency` | `SWARM_CONSISTENCY_APP_ID`, `SWARM_CONSISTENCY_PRIVATE_KEY` |
| `performance` | `SWARM_PERFORMANCE_APP_ID`, `SWARM_PERFORMANCE_PRIVATE_KEY` |
| `architect` | `SWARM_ARCHITECT_APP_ID`, `SWARM_ARCHITECT_PRIVATE_KEY` |
| `pragmatist` | `SWARM_PRAGMATIST_APP_ID`, `SWARM_PRAGMATIST_PRIVATE_KEY` |
| `collaborator` | `SWARM_COLLABORATOR_APP_ID`, `SWARM_COLLABORATOR_PRIVATE_KEY` |
| `mediator` | `SWARM_MEDIATOR_APP_ID`, `SWARM_MEDIATOR_PRIVATE_KEY` |

`_PRIVATE_KEY`에는 `.pem` 파일 내용을 그대로 붙여넣는다. `\n`으로 이스케이프된 형태나 base64도 자동으로 처리한다.

**일부만 등록해도 된다.** App 자격이 없는 에이전트는 워크플로의 기본 `GITHUB_TOKEN`으로 게시되고, 코멘트 머리에 페르소나 이름이 표시된다. 처음에는 `publish.mode: single`로 시작해서 동작을 확인한 뒤 App을 붙이는 것을 권한다.

### 6. 머지 차단을 실제로 걸려면

두 가지 방법이 있고, 둘 다 써도 된다.

- **브랜치 보호**: `Require a pull request before merging` + `Require approvals`를 켜면, Mediator 봇의 `CHANGES_REQUESTED` 리뷰가 머지를 막는다. 후속 커밋에서 문제가 해소되면 review-swarm이 자기 리뷰를 자동으로 dismiss 한다.
- **필수 상태 체크**: 워크플로에서 `fail-on: request_changes`로 두고 이 job을 required check으로 지정한다.

## 로컬에서 돌려보기

```bash
node dist/cli.js review --repo owner/name --pr 123 --workdir /path/to/checkout --dry-run
```

`--dry-run`은 GitHub에 아무것도 올리지 않고 실행 산출물만 남긴다. `--engine mock`을 주면 모델을 한 번도 호출하지 않고 배선만 검증한다.

산출물은 `<workdir>/.review-swarm/<pr>-<sha>-<run>/`에 남는다.

```
blackboard.md          모든 에이전트가 공유한 컨텍스트
diff.patch             필터링된 전체 diff
routing.json           누가 왜 선택됐는지
prompts/<agent>.md     실제로 보낸 프롬프트 전문
findings/<agent>.json  에이전트별 원본 finding
verify.json            검증 표결과 사유
debate.json            토론 기록
mediation.json         조정자 판정
outcome.json           정책 게이트 통과 결과
run.json               실행 요약
```

리뷰 품질이 이상하면 `prompts/`와 `findings/`부터 본다.

## 설정

전체 예시는 [`review-swarm.example.yaml`](review-swarm.example.yaml)에 있다. 자주 만지는 것만:

```yaml
engine:
  default: claude
  concurrency: 4          # 동시에 도는 에이전트 수
  timeoutMs: 900000

agents:
  security:
    engine: codex         # 에이전트별로 다른 엔진/모델을 섞을 수 있다
  architect:
    model: haiku          # 가치 에이전트는 저렴하게

router:
  always: [security, pragmatist]
  maxAgents: 6            # 한 PR당 최대 전문가 수 (비용 상한)
  fullSweepChangedLines: 400

verify:
  voters: 1               # 중요한 저장소는 3 (다수결 반박)

policy:
  maxInlineTotal: 25      # PR당 인라인 코멘트 상한
  blockMinConfidence: 0.7

publish:
  mode: apps              # apps | single | none
```

### 비용 조절

한 PR의 모델 호출 수는 대략

```
선택된 전문가 수  +  (verify 대상 finding 수 × voters)  +  (debate 쌍 × 2)  +  1(mediator)
```

가장 효과적인 조절 손잡이는 `router.maxAgents`, `verify.minSeverity`, `debate.enabled`, 그리고 에이전트별 `model`이다.

## 보안

이 도구는 **PR이 가져온 코드를 self-hosted 러너에서 다룬다.** 다음을 지켜야 한다.

1. **`pull_request_target`을 쓰지 마라.** 템플릿은 `pull_request`를 쓴다. `pull_request_target`은 PR의 코드를 base 저장소 시크릿과 함께 실행시킨다.
2. **fork PR을 기본적으로 제외한다.** 템플릿의 `if: github.event.pull_request.head.repo.full_name == github.repository` 가드를 지우지 마라.
3. **`checks:`는 PR 코드를 실행한다.** `npm test` 같은 명령을 넣으면 그 코드가 러너에서 돈다. fork PR을 리뷰한다면 반드시 비워라.
4. **엔진은 읽기 전용으로 돈다.** claude는 `--tools Read,Grep,Glob`, codex는 `--sandbox read-only`로 실행된다. 설정에서 이걸 완화하지 마라.
5. **프롬프트 인젝션을 데이터로 취급한다.** diff, PR 본문, 커밋 메시지, 테스트 출력은 blackboard에서 "신뢰할 수 없는 입력"으로 명시적으로 라벨링되고, 모든 페르소나는 그 안의 지시문을 따르지 말고 오히려 `prompt-injection` finding으로 보고하도록 지시받는다. 최종 머지 판정은 모델이 아니라 결정론적 정책 게이트가 내린다.
6. **이 액션을 40자리 커밋 SHA로 고정하라.** `@main` 같은 mutable 참조를 쓰면, 이 저장소의 `main`에 들어간 코드가 다음 PR에서 그대로 대상 저장소의 self-hosted 러너에서 실행된다. 그 실행에는 GitHub App PRIVATE_KEY들이 env로 전달되고 `pull-requests: write` 권한이 붙는다. fork 가드는 이 경로를 막지 못한다 — 공격 표면이 PR이 아니라 참조된 액션이기 때문이다. 업데이트는 새 커밋을 확인한 뒤 SHA를 올리는 방식으로 한다.
7. **체크아웃에 토큰을 남기지 않는다.** 템플릿은 `persist-credentials: false`를 쓴다. 리뷰는 로컬 git 읽기(`diff`/`merge-base`)만 하고 GitHub 호출은 자체 토큰·App 자격으로 하므로 필요 없다. `fetch-depth: 0`으로 전체 히스토리를 받으므로 추가 fetch도 일어나지 않는다.

## 동작 세부

**앵커링.** GitHub는 diff에 없는 라인에 인라인 코멘트를 달면 리뷰 전체를 422로 거절한다. 그래서 모델이 지목한 라인을 diff에 실제로 존재하는 라인으로 스냅한다(기본 최대 20줄). 스냅할 수 없으면 인라인 대신 요약에 넣는다. 스냅이 일어나면 코멘트에 원래 위치를 표시한다. `suggestion` 블록은 앵커가 정확히 일치할 때만 렌더링된다 — 어긋난 범위에 suggestion을 달면 잘못된 코드를 적용시키기 때문이다.

**중복 억제.** 각 코멘트에는 `<!-- review-swarm:v1 agent=... fp=... -->` 마커가 들어간다. 새 커밋에서 다시 돌 때 같은 지문의 코멘트는 다시 달지 않고 요약에만 "이미 지적한 항목"으로 표시한다.

**부분 실패.** 에이전트 하나가 실패해도 나머지 결과로 리뷰를 게시하고, 요약 하단에 무엇이 실패했는지 적는다. 조정자가 실패하면 심각도 기반 기본 판정으로 폴백한다.

## 개발

```bash
npm install
npm run check     # 타입체크 + 테스트
npm run build
```

테스트는 실제 git 저장소를 만들어 `mock` 엔진으로 전체 파이프라인을 돌리는 e2e를 포함한다(`test/e2e.test.ts`). 모델 호출은 없다.

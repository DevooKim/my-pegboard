//! Jira REST v3 응답 타입.
//!
//! 두 가지 원칙이 이 파일의 모양을 결정한다.
//!
//! 1. **필드 축소** (DECISIONS 6장). Jira는 이슈당 ~200 필드를 준다. 목록 위젯은 6개면 된다.
//!    그래서 목록용 [`JiraIssue`]와 상세용 [`JiraIssueDetail`]을 나눴다. 목록 30건에
//!    상세 필드를 실어 보내면 IPC 페이로드가 그대로 10배가 된다.
//!
//! 2. **Jira는 거의 모든 게 null일 수 있다.** 담당자 없는 티켓, 우선순위 없는 프로젝트,
//!    아바타 없는 계정 — 전부 실재한다. 낙관적으로 파싱하면 런타임에 깨진다.
//!
//! ADF(`description`, 코멘트 `body`)는 [`Adf`] = `serde_json::Value`로 **그대로 통과**시킨다.
//! 여기서 HTML이나 텍스트로 변환하지 않는다 — 렌더링은 프론트 책임 (DECISIONS 11.4).

use serde::{Deserialize, Serialize};

/// Atlassian Document Format 문서. 우리는 해석하지 않고 프론트로 넘긴다.
///
/// specta에서 `serde_json::Value`는 TS `any`로 나간다. ADF 노드 타입이 수십 개라
/// Rust에서 모델링할 값어치가 없다 — 우리는 어차피 한 필드도 읽지 않는다.
pub type Adf = serde_json::Value;

// ---------------------------------------------------------------------------
// 공통 하위 객체
// ---------------------------------------------------------------------------

/// 사용자. 식별자는 **`accountId`** — 이메일/username이 아니다 (GDPR 이후 Cloud 정책).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraUser {
    pub account_id: String,
    /// 드물게 비어 있다(비활성/삭제된 계정). 그래도 항상 문자열은 온다.
    #[serde(default)]
    pub display_name: String,
    /// 48x48 아바타 URL. 아바타가 없는 계정이 실제로 있다.
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// 원시 응답의 `avatarUrls` 맵에서 48x48을 골라내기 위한 중간 표현.
#[derive(Debug, Clone, Deserialize)]
struct RawUser {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "avatarUrls", default)]
    avatar_urls: Option<AvatarUrls>,
}

#[derive(Debug, Clone, Deserialize)]
struct AvatarUrls {
    #[serde(rename = "48x48")]
    x48: Option<String>,
    #[serde(rename = "32x32")]
    x32: Option<String>,
    #[serde(rename = "24x24")]
    x24: Option<String>,
    #[serde(rename = "16x16")]
    x16: Option<String>,
}

impl AvatarUrls {
    /// 큰 것부터. 위젯 행은 24px로 그리지만 레티나에서 흐려지지 않게 48을 쓴다.
    fn best(&self) -> Option<String> {
        self.x48
            .clone()
            .or_else(|| self.x32.clone())
            .or_else(|| self.x24.clone())
            .or_else(|| self.x16.clone())
    }
}

impl From<RawUser> for JiraUser {
    fn from(raw: RawUser) -> Self {
        JiraUser {
            account_id: raw.account_id,
            display_name: raw.display_name.unwrap_or_default(),
            avatar_url: raw.avatar_urls.and_then(|a| a.best()),
        }
    }
}

/// 사용자 필드 전용 역직렬화: `avatarUrls` 맵을 단일 URL로 접는다.
fn de_user<'de, D>(de: D) -> Result<Option<JiraUser>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<RawUser>::deserialize(de)?;
    Ok(raw.map(JiraUser::from))
}

/// 상태 카테고리. 색을 칠하는 근거는 상태 **이름**이 아니라 이것이다.
///
/// 상태 이름은 프로젝트마다 다르다("완료"/"Done"/"배포됨"). `statusCategory.key`는
/// `new` / `indeterminate` / `done` 세 가지로 고정이라 위젯이 믿을 수 있는 유일한 축이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatusCategory {
    /// `new` | `indeterminate` | `done` (Jira가 보장하는 고정 키)
    pub key: String,
    /// `blue-gray` | `yellow` | `green` — 표시용 힌트
    #[serde(default)]
    pub color_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatus {
    pub name: String,
    /// 워크플로우가 이상하게 설정된 프로젝트에서 누락될 수 있다.
    #[serde(default)]
    pub status_category: Option<JiraStatusCategory>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraPriority {
    pub name: String,
    #[serde(default)]
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueType {
    pub name: String,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub subtask: bool,
}

// ---------------------------------------------------------------------------
// 목록용 (슬림)
// ---------------------------------------------------------------------------

/// 목록 위젯 행 하나. **여기 필드를 늘리기 전에 [`LIST_FIELDS`]와 페이로드 크기를 생각할 것.**
///
/// `Deserialize`는 파일 아래쪽에 손으로 구현했다 — Jira의 `{key, fields:{...}}` 중첩을
/// 평평하게 펴고 `avatarUrls` 맵을 URL 하나로 접어야 하기 때문.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    /// `PROJ-123`. 사용자에게 보이는 유일한 식별자이자 우리 캐시 키.
    pub key: String,
    pub summary: String,
    pub status: Option<JiraStatus>,
    /// 담당자 없음은 흔하다. 백로그 티켓 대부분이 그렇다.
    pub assignee: Option<JiraUser>,
    /// 우선순위 스킴을 끈 프로젝트에서는 null.
    pub priority: Option<JiraPriority>,
    pub issue_type: Option<JiraIssueType>,
    /// ISO 8601 + 오프셋 (`2026-07-29T14:03:11.482+0900`). 기본 정렬 축.
    pub updated: Option<String>,
    pub created: Option<String>,
    /// `2026-07-27` (시각 없음). 실측 9/22만 채워져 있다.
    pub due_date: Option<String>,
    pub parent: Option<JiraParent>,
    /// 활성 스프린트 하나. 여러 개면 첫 번째.
    pub sprint: Option<JiraSprint>,
}

/// 스프린트 하나. Jira는 배열로 주지만(과거 스프린트 포함) 표시에는 활성 것 하나면 된다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraSprint {
    pub name: String,
    /// `active` | `closed` | `future`
    #[serde(default)]
    pub state: Option<String>,
}

/// 상위 항목. 팀 관리형에서는 에픽이고, 하위 작업이면 부모 티켓이다.
///
/// 구 `customfield_10014`(에픽 링크)는 쓰지 않는다 — 실측 결과 `parent`가
/// 20/22, 에픽 링크가 6/22로 `parent` 쪽이 훨씬 잘 채워져 있다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraParent {
    pub key: String,
    #[serde(default)]
    pub summary: Option<String>,
}

/// 이슈 하나의 `fields` 봉투. 목록/상세가 같은 구조를 공유한다.
///
/// `Default`를 유도해 둔다 — 필드를 추가할 때마다 사용처의 구조체 리터럴을
/// 전부 고쳐야 하면 반드시 하나를 빠뜨린다.
#[derive(Debug, Clone, Default, Deserialize)]
struct RawFields {
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    status: Option<JiraStatus>,
    #[serde(default, deserialize_with = "de_user")]
    assignee: Option<JiraUser>,
    #[serde(default, deserialize_with = "de_user")]
    reporter: Option<JiraUser>,
    #[serde(default)]
    priority: Option<JiraPriority>,
    #[serde(default, rename = "issuetype")]
    issue_type: Option<JiraIssueType>,
    #[serde(default)]
    updated: Option<String>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    description: Option<Adf>,
    #[serde(default, rename = "duedate")]
    due_date: Option<String>,
    #[serde(default, deserialize_with = "de_parent")]
    parent: Option<JiraParent>,
    /// 스프린트는 커스텀 필드다. 사이트마다 id가 다를 수 있으나
    /// 이 사이트는 10020으로 확인됐다.
    #[serde(default, rename = "customfield_10020", deserialize_with = "de_sprint")]
    sprint: Option<JiraSprint>,
}

/// `parent`는 `{key, fields:{summary}}` 중첩이라 평평하게 편다.
fn de_parent<'de, D>(de: D) -> Result<Option<JiraParent>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    struct RawParent {
        key: String,
        #[serde(default)]
        fields: Option<RawParentFields>,
    }
    #[derive(Deserialize)]
    struct RawParentFields {
        #[serde(default)]
        summary: Option<String>,
    }
    Ok(Option::<RawParent>::deserialize(de)?.map(|p| JiraParent {
        key: p.key,
        summary: p.fields.and_then(|f| f.summary),
    }))
}

/// 스프린트는 배열로 온다(과거 스프린트 포함). 활성 것을 고르고,
/// 없으면 마지막 것 — 완료된 스프린트라도 안 보여주는 것보다 낫다.
fn de_sprint<'de, D>(de: D) -> Result<Option<JiraSprint>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let list = Option::<Vec<JiraSprint>>::deserialize(de)?.unwrap_or_default();
    Ok(list
        .iter()
        .find(|s| s.state.as_deref() == Some("active"))
        .or_else(|| list.last())
        .cloned())
}

#[derive(Debug, Clone, Deserialize)]
struct RawIssue {
    key: String,
    #[serde(default)]
    fields: Option<RawFields>,
}

impl From<RawIssue> for JiraIssue {
    fn from(raw: RawIssue) -> Self {
        let f = raw.fields.unwrap_or_default();
        JiraIssue {
            key: raw.key,
            // 요약이 없는 이슈는 없지만, 없으면 빈 행이 뜨는 게 파싱 실패보다 낫다.
            summary: f.summary.unwrap_or_default(),
            status: f.status,
            assignee: f.assignee,
            priority: f.priority,
            issue_type: f.issue_type,
            updated: f.updated,
            created: f.created,
            due_date: f.due_date,
            parent: f.parent,
            sprint: f.sprint,
        }
    }
}

impl<'de> Deserialize<'de> for JiraIssueDetail {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawIssue::deserialize(de)?;
        let f = raw.fields.unwrap_or_default();
        Ok(JiraIssueDetail {
            key: raw.key,
            summary: f.summary.unwrap_or_default(),
            status: f.status,
            assignee: f.assignee,
            reporter: f.reporter,
            priority: f.priority,
            issue_type: f.issue_type,
            updated: f.updated,
            created: f.created,
            labels: f.labels.unwrap_or_default(),
            description: f.description.filter(|v| !v.is_null()),
        })
    }
}

/// `JiraIssue`를 Jira 원시 응답에서 읽기 위한 어댑터.
impl<'de> Deserialize<'de> for JiraIssue {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        RawIssue::deserialize(de).map(JiraIssue::from)
    }
}

// ---------------------------------------------------------------------------
// 상세용
// ---------------------------------------------------------------------------

/// 상세 모달용. 목록 필드 + 보고자·라벨·생성일·ADF 설명 (DECISIONS 11.4).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueDetail {
    pub key: String,
    pub summary: String,
    pub status: Option<JiraStatus>,
    pub assignee: Option<JiraUser>,
    pub reporter: Option<JiraUser>,
    pub priority: Option<JiraPriority>,
    pub issue_type: Option<JiraIssueType>,
    pub updated: Option<String>,
    pub created: Option<String>,
    /// 라벨 없음은 `null`이 아니라 `[]`로 정규화한다 — 프론트 분기 하나를 없앤다.
    pub labels: Vec<String>,
    /// ADF 문서 그대로. 설명이 비어 있으면 `None`.
    pub description: Option<Adf>,
}

// ---------------------------------------------------------------------------
// 검색 (커서 페이지네이션)
// ---------------------------------------------------------------------------

/// `/rest/api/3/search/jql` 한 페이지.
///
/// **`total`이 없다.** 신규 엔드포인트는 총 개수를 주지 않는다 (DECISIONS 8장).
/// 이 타입에 `total`을 추가하지 말 것 — 우리는 그 숫자를 모르고, 추정치를 보여주면 거짓말이 된다.
/// "총 42건 중 30건" 같은 UI는 만들 수 없다.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub issues: Vec<JiraIssue>,
    /// 다음 페이지 커서. `None`이면 마지막 페이지다.
    pub next_page_token: Option<String>,
}

impl SearchPage {
    /// 뒤에 더 있는가. `is_last` 필드를 따로 두지 않는 이유: 커서 유무가 곧 답이다.
    pub fn has_more(&self) -> bool {
        self.next_page_token.is_some()
    }
}

#[derive(Debug, Deserialize)]
struct RawSearchPage {
    #[serde(default)]
    issues: Vec<RawIssue>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
    /// Jira는 마지막 페이지에서 `isLast: true`를 주기도 하고 아예 생략하기도 한다.
    /// 커서가 있는데 `isLast: true`인 모순 응답을 봤을 때 커서를 버리는 데만 쓴다.
    #[serde(default, rename = "isLast")]
    is_last: Option<bool>,
}

impl<'de> Deserialize<'de> for SearchPage {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawSearchPage::deserialize(de)?;
        let next = match raw.is_last {
            // isLast가 명시적으로 true면 커서가 있어도 무시한다. 안 그러면 무한 루프.
            Some(true) => None,
            _ => raw.next_page_token.filter(|t| !t.is_empty()),
        };
        Ok(SearchPage {
            issues: raw.issues.into_iter().map(JiraIssue::from).collect(),
            next_page_token: next,
        })
    }
}

// ---------------------------------------------------------------------------
// 코멘트
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraComment {
    pub id: String,
    pub author: Option<JiraUser>,
    pub created: Option<String>,
    pub updated: Option<String>,
    /// ADF 본문. 설명과 동일하게 그대로 통과.
    pub body: Option<Adf>,
}

#[derive(Debug, Deserialize)]
struct RawComment {
    id: String,
    #[serde(default, deserialize_with = "de_user")]
    author: Option<JiraUser>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    updated: Option<String>,
    #[serde(default)]
    body: Option<Adf>,
}

impl<'de> Deserialize<'de> for JiraComment {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawComment::deserialize(de)?;
        Ok(JiraComment {
            id: raw.id,
            author: raw.author,
            created: raw.created,
            updated: raw.updated,
            body: raw.body.filter(|v| !v.is_null()),
        })
    }
}

/// `/issue/{key}/comment` 응답.
///
/// 코멘트 엔드포인트는 **구식 offset 페이지네이션**이라 `total`을 준다.
/// 검색과 다르다 — 여기서는 총 개수를 써도 정직하다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    #[serde(default)]
    pub comments: Vec<JiraComment>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub start_at: u32,
    #[serde(default)]
    pub max_results: u32,
}

// ---------------------------------------------------------------------------
// createmeta
// ---------------------------------------------------------------------------

/// createmeta가 알려주는 필드 하나 (DECISIONS 11.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateMetaField {
    /// `summary`, `reporter`, `customfield_10011` …
    pub field_id: String,
    pub name: String,
    pub required: bool,
    /// **`true`면 폼에 그리지 않는다.** 서버가 기본값을 채운다.
    pub has_default_value: bool,
    /// `string` | `user` | `priority` | `array` | `option` …
    pub schema_type: Option<String>,
    /// 드롭다운을 추가 API 호출 없이 채울 수 있다 (DECISIONS 11.3 "부수 발견").
    pub allowed_values: Vec<AllowedValue>,
}

/// `allowedValues` 항목. Jira는 필드 종류마다 다른 모양을 주므로
/// 공통분모(id/value/name)만 뽑고 원본은 `raw`로 남긴다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AllowedValue {
    pub id: Option<String>,
    /// 화면에 보일 문자열. `name` → `value` → `id` 순으로 찾는다.
    pub label: Option<String>,
}

/// 특정 프로젝트+이슈타입의 생성 폼 스키마.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateMeta {
    pub fields: Vec<CreateMetaField>,
}

impl CreateMeta {
    /// **사용자가 반드시 입력해야 하는 필드.**
    ///
    /// `required: true` 이면서 `hasDefaultValue: false`인 것만. 이게 DECISIONS 11.3의 규칙이다.
    /// XYZ의 `reporter`가 `hasDefaultValue: true`라면 폼에 안 그려도 생성이 성공한다.
    pub fn required_user_input(&self) -> Vec<&CreateMetaField> {
        self.fields
            .iter()
            .filter(|f| f.required && !f.has_default_value)
            .collect()
    }

    /// 스키마상 required인 전체 필드 (기본값 있는 것 포함). 디버깅/표시용.
    pub fn required_field_ids(&self) -> Vec<&str> {
        self.fields
            .iter()
            .filter(|f| f.required)
            .map(|f| f.field_id.as_str())
            .collect()
    }

    pub fn field(&self, field_id: &str) -> Option<&CreateMetaField> {
        self.fields.iter().find(|f| f.field_id == field_id)
    }
}

/// createmeta 원시 응답.
///
/// v3의 `/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`는
/// `{ "fields": [ {...}, ... ] }` — **배열**이다.
/// (구 `/issue/createmeta?expand=...`의 `fields`는 맵이었다. 둘 다 받아준다.)
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawCreateMetaFields {
    List(Vec<RawCreateMetaField>),
    Map(std::collections::BTreeMap<String, RawCreateMetaField>),
}

#[derive(Debug, Deserialize)]
struct RawCreateMeta {
    #[serde(default)]
    fields: Option<RawCreateMetaFields>,
}

#[derive(Debug, Deserialize)]
struct RawCreateMetaField {
    #[serde(rename = "fieldId", default)]
    field_id: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    required: bool,
    #[serde(rename = "hasDefaultValue", default)]
    has_default_value: bool,
    #[serde(default)]
    schema: Option<RawFieldSchema>,
    #[serde(rename = "allowedValues", default)]
    allowed_values: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RawFieldSchema {
    #[serde(rename = "type", default)]
    type_: Option<String>,
}

impl RawCreateMetaField {
    fn into_field(self, map_key: Option<&str>) -> CreateMetaField {
        let field_id = self
            .field_id
            .or_else(|| self.key.clone())
            .or_else(|| map_key.map(str::to_owned))
            .unwrap_or_default();
        CreateMetaField {
            name: self.name.unwrap_or_else(|| field_id.clone()),
            field_id,
            required: self.required,
            has_default_value: self.has_default_value,
            schema_type: self.schema.and_then(|s| s.type_),
            allowed_values: self
                .allowed_values
                .into_iter()
                .map(|v| AllowedValue {
                    id: v.get("id").and_then(|x| x.as_str()).map(str::to_owned),
                    label: v
                        .get("name")
                        .and_then(|x| x.as_str())
                        .or_else(|| v.get("value").and_then(|x| x.as_str()))
                        .or_else(|| v.get("id").and_then(|x| x.as_str()))
                        .map(str::to_owned),
                })
                .collect(),
        }
    }
}

impl<'de> Deserialize<'de> for CreateMeta {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawCreateMeta::deserialize(de)?;
        let fields = match raw.fields {
            Some(RawCreateMetaFields::List(list)) => {
                list.into_iter().map(|f| f.into_field(None)).collect()
            }
            Some(RawCreateMetaFields::Map(map)) => map
                .into_iter()
                .map(|(k, f)| {
                    let key = k.clone();
                    f.into_field(Some(&key))
                })
                .collect(),
            None => Vec::new(),
        };
        Ok(CreateMeta { fields })
    }
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

/// 티켓 생성 요청. 최소 폼 + createmeta로 알아낸 추가 필드 (DECISIONS 11.3).
///
/// `extra_fields`가 있는 이유: 프로젝트마다 필수 필드가 다르므로(XYZ의 `reporter`)
/// 컴파일 타임에 필드 목록을 고정할 수 없다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateIssueInput {
    /// 프로젝트 키 (`ABC`, `XYZ`, …)
    pub project_key: String,
    /// 이슈타입 **id** (`10082`). 이름이 아니라 id다 — 같은 이름의 타입이 여럿일 수 있다.
    pub issue_type_id: String,
    pub summary: String,
    /// ADF 문서. 프론트가 만들어 보낸다.
    #[serde(default)]
    pub description: Option<Adf>,
    /// createmeta가 요구한 나머지 필드. `{"reporter": {"id": "..."}}` 형태 그대로.
    #[serde(default)]
    pub extra_fields: std::collections::BTreeMap<String, serde_json::Value>,
}

impl CreateIssueInput {
    /// `/rest/api/3/issue` 가 받는 `{"fields": {...}}` 본문을 만든다.
    ///
    /// `extra_fields`는 마지막에 병합한다 — 필요하면 기본 필드를 덮어쓸 수 있게.
    pub fn to_payload(&self) -> serde_json::Value {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "project".into(),
            serde_json::json!({ "key": self.project_key }),
        );
        fields.insert(
            "issuetype".into(),
            serde_json::json!({ "id": self.issue_type_id }),
        );
        fields.insert("summary".into(), serde_json::json!(self.summary));
        if let Some(desc) = &self.description {
            if !desc.is_null() {
                fields.insert("description".into(), desc.clone());
            }
        }
        for (k, v) in &self.extra_fields {
            fields.insert(k.clone(), v.clone());
        }
        serde_json::json!({ "fields": fields })
    }
}

/// 생성 성공 응답. Jira는 키/id/self만 돌려준다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedIssue {
    pub id: String,
    pub key: String,
    #[serde(rename = "self", default)]
    pub self_url: Option<String>,
}

// ---------------------------------------------------------------------------
// 연결 테스트
// ---------------------------------------------------------------------------

/// 설정창 "연결 테스트" 결과. `/myself` 응답에서 뽑는다.
///
/// `Deserialize`는 아래에 손으로 구현했다 (`avatarUrls` 맵 접기).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraIdentity {
    pub account_id: String,
    #[serde(default)]
    pub display_name: String,
    /// 사이트 개인정보 설정에 따라 숨겨질 수 있다. 없다고 실패가 아니다.
    #[serde(default)]
    pub email_address: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

impl<'de> Deserialize<'de> for JiraIdentity {
    fn deserialize<D>(de: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(rename = "accountId")]
            account_id: String,
            #[serde(rename = "displayName", default)]
            display_name: Option<String>,
            #[serde(rename = "emailAddress", default)]
            email_address: Option<String>,
            #[serde(rename = "avatarUrls", default)]
            avatar_urls: Option<AvatarUrls>,
        }
        let raw = Raw::deserialize(de)?;
        Ok(JiraIdentity {
            account_id: raw.account_id,
            display_name: raw.display_name.unwrap_or_default(),
            email_address: raw.email_address,
            avatar_url: raw.avatar_urls.and_then(|a| a.best()),
        })
    }
}

// ---------------------------------------------------------------------------
// 필드 세트
// ---------------------------------------------------------------------------

/// 목록 조회에서 요청할 필드. **성능 요구사항이다** (DECISIONS 6장 2번).
///
/// Jira 기본값은 `*navigable` — 이슈당 ~200 필드가 온다. 30건이면 수백 KB.
/// 필요한 것만 요청해 응답을 크게 줄이는 것이 이 앱이 Jira 웹보다 빠른 이유의 일부다.
///
/// **측정값 (15건):** 6필드 31KB → 10필드 56KB (+79%).
/// 증가분의 대부분(19KB)은 `parent`다 — Jira가 상위 티켓의 fields를 통째로
/// 실어 보내는데 우리는 key와 summary만 쓴다. 줄일 방법이 없으므로 감수한다.
/// WebView로 넘어가는 IPC 페이로드는 Rust가 축소한 뒤라 이보다 훨씬 작다.
///
/// **여기에 필드를 더하기 전에 반드시 크기를 재고 이 주석을 갱신할 것.**
pub const LIST_FIELDS: &[&str] = &[
    "summary",
    "status",
    "assignee",
    "priority",
    "issuetype",
    "updated",
    "created",
    "duedate",
    "parent",
    // 스프린트 커스텀 필드 (실측). 다른 사이트에서는 id가 다를 수 있고,
    // 그 경우 이 필드는 그냥 비어서 온다 — 요청 자체는 실패하지 않는다.
    "customfield_10020",
];

/// 상세 모달용 필드. 목록 + 보고자·라벨·생성일·설명(ADF).
pub const DETAIL_FIELDS: &[&str] = &[
    "summary",
    "status",
    "assignee",
    "reporter",
    "priority",
    "issuetype",
    "updated",
    "created",
    "labels",
    "description",
    "duedate",
    "parent",
    "customfield_10020",
];

#[cfg(test)]
#[path = "tests/types_tests.rs"]
mod types_tests;

// ---------------------------------------------------------------------------
// 프로젝트 목록 (위젯 범위 좁히기용)
// ---------------------------------------------------------------------------

/// 프로젝트 선택 드롭다운 한 항목.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JiraProject {
    /// `ABC`. JQL에 그대로 들어가는 값이다.
    pub key: String,
    pub name: String,
}

/// `/rest/api/3/project/search` 응답 중 우리가 쓰는 부분.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ProjectSearchPage {
    #[serde(default)]
    pub values: Vec<JiraProject>,
    #[serde(default)]
    pub is_last: bool,
}

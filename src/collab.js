import {Plugin, PluginKey, TextSelection} from "prosemirror-state"

class Rebaseable {
  constructor(step, inverted, origin) {
    this.step = step
    this.inverted = inverted
    this.origin = origin
  }
}

// : ([Rebaseable], [Step], Transform) → [Rebaseable]
// Undo a given set of steps, apply a set of other steps, and then
// redo them.
export function rebaseSteps(steps, over, transform) {
  for (let i = steps.length - 1; i >= 0; i--) transform.step(steps[i].inverted)
  for (let i = 0; i < over.length; i++) transform.step(over[i])
  let result = []
  for (let i = 0, mapFrom = steps.length; i < steps.length; i++) {
    let mapped = steps[i].step.map(transform.mapping.slice(mapFrom))
    mapFrom--
    if (mapped && !transform.maybeStep(mapped).failed) {
      transform.mapping.setMirror(mapFrom, transform.steps.length - 1)
      result.push(new Rebaseable(mapped, mapped.invert(transform.docs[transform.docs.length - 1]), steps[i].origin))
    }
  }
  return result
}

// This state field accumulates changes that have to be sent to the
// central authority in the collaborating group and makes it possible
// to integrate changes made by peers into our local document. It is
// defined by the plugin, and will be available as the `collab` field
// in the resulting editor state.
class CollabState {
  constructor(version, unconfirmed) {
    // : number
    // The version number of the last update received from the central
    // authority. Starts at 0 or the value of the `version` property
    // in the option object, for the editor's value when the option
    // was enabled.
    this.version = version

    // : [Rebaseable]
    // The local steps that havent been successfully sent to the
    // server yet.
    this.unconfirmed = unconfirmed
  }
}

function unconfirmedFrom(transform) {
  let result = []
  for (let i = 0; i < transform.steps.length; i++)
    result.push(new Rebaseable(transform.steps[i],
                               transform.steps[i].invert(transform.docs[i]),
                               transform))
  return result
}

const collabKey = new PluginKey("collab")

// :: (?Object) → Plugin
//
// Creates a plugin that enables the collaborative editing framework
// for the editor.
//
// @cn 创建一个能使编辑器支持协同编辑框架的插件。
//
//   config::- An optional set of options
//
//   @cn 可选参数对象。
//
//     version:: ?number
//     The starting version number of the collaborative editing.
//     Defaults to 0.
//
//     @cn 协同编辑的起始版本号，默认是 0.
//
//     clientID:: ?union<number, string>
//     This client's ID, used to distinguish its changes from those of
//     other clients. Defaults to a random 32-bit number.
//
//     @cn 客户端 ID，用来分别哪些修改是自己做的哪些是其他客户端做的。默认是一个随机的 32 位数字。
export function collab(config = {}) {
  config = {version: config.version || 0,
            clientID: config.clientID == null ? Math.floor(Math.random() * 0xFFFFFFFF) : config.clientID}

  return new Plugin({
    key: collabKey,

    state: {
      init: () => new CollabState(config.version, []),
      apply(tr, collab) {
        let newState = tr.getMeta(collabKey)
        if (newState)
          return newState
        if (tr.docChanged)
          return new CollabState(collab.version, collab.unconfirmed.concat(unconfirmedFrom(tr)))
        return collab
      }
    },

    config,
    // This is used to notify the history plugin to not merge steps,
    // so that the history can be rebased.
    historyPreserveItems: true
  })
}

// :: (state: EditorState, steps: [Step], clientIDs: [union<number, string>], options: ?Object) → Transaction
// Create a transaction that represents a set of new steps received from
// the authority. Applying this transaction moves the state forward to
// adjust to the authority's view of the document.
//
// @cn 创建一个接受自鉴权中心的表示新 steps 集合的 transaction。应用该 transaction 以将 state 向前移动来适应文档的鉴权中心的视图。
//
// @comment 「鉴权中心」指的就是协同处理的服务端，那里负责处理接受那些 tr，拒绝哪些 tr。
//
//   options::- Additional options.
//
//   @cn 可选的配置参数。
//
//     mapSelectionBackward:: ?boolean
//     When enabled (the default is `false`), if the current selection
//     is a [text selection](#state.TextSelection), its sides are
//     mapped with a negative bias for this transaction, so that
//     content inserted at the cursor ends up after the cursor. Users
//     usually prefer this, but it isn't done by default for reasons
//     of backwards compatibility.
//
//     @cn 启用后（默认是 `false`），如果当前选区是一个 [文本选区](#state.TextSelection)，则它的两侧位置会被这个
//     transaction 通过一个负向偏移 mapped，以便使插入光标处的内容会以光标所在的位置结尾。用户通常倾向于这样做，不过因为向后兼容的
//     原因，默认情况下不会这么做。
export function receiveTransaction(state, steps, clientIDs, options) {
  // Pushes a set of steps (received from the central authority) into
  // the editor state (which should have the collab plugin enabled).
  // Will recognize its own changes, and confirm unconfirmed steps as
  // appropriate. Remaining unconfirmed steps will be rebased over
  // remote steps.
  let collabState = collabKey.getState(state)
  let version = collabState.version + steps.length
  let ourID = collabKey.get(state).spec.config.clientID

  // Find out which prefix of the steps originated with us
  let ours = 0
  while (ours < clientIDs.length && clientIDs[ours] == ourID) ++ours
  let unconfirmed = collabState.unconfirmed.slice(ours)
  steps = ours ? steps.slice(ours) : steps

  // If all steps originated with us, we're done.
  if (!steps.length)
    return state.tr.setMeta(collabKey, new CollabState(version, unconfirmed))

  let nUnconfirmed = unconfirmed.length
  let tr = state.tr
  if (nUnconfirmed) {
    unconfirmed = rebaseSteps(unconfirmed, steps, tr)
  } else {
    for (let i = 0; i < steps.length; i++) tr.step(steps[i])
    unconfirmed = []
  }

  let newCollabState = new CollabState(version, unconfirmed)
  if (options && options.mapSelectionBackward && state.selection instanceof TextSelection) {
    tr.setSelection(TextSelection.between(tr.doc.resolve(tr.mapping.map(state.selection.anchor, -1)),
                                          tr.doc.resolve(tr.mapping.map(state.selection.head, -1)), -1))
    tr.updated &= ~1
  }
  return tr.setMeta("rebased", nUnconfirmed).setMeta("addToHistory", false).setMeta(collabKey, newCollabState)
}

// :: (state: EditorState) → ?{version: number, steps: [Step], clientID: union<number, string>, origins: [Transaction]}
// Provides data describing the editor's unconfirmed steps, which need
// to be sent to the central authority. Returns null when there is
// nothing to send.
//
// @cn 提供编辑器未被确认的 steps 的数据描述，它会被发送给鉴权中心。如果没有需要发送的东西，返回 null。
//
// `origins` holds the _original_ transactions that produced each
// steps. This can be useful for looking up time stamps and other
// metadata for the steps, but note that the steps may have been
// rebased, whereas the origin transactions are still the old,
// unchanged objects.
//
// @cn `origins` 值是产生每个 steps 的 _原始_ transactions。对于寻找 steps 的时间戳和其他 metadata 信息很有用，不过记住，steps 可能会被 rebased，
// 因此原始的 transaction 仍然是旧的，未改变的对象。
export function sendableSteps(state) {
  let collabState = collabKey.getState(state)
  if (collabState.unconfirmed.length == 0) return null
  return {
    version: collabState.version,
    steps: collabState.unconfirmed.map(s => s.step),
    clientID: collabKey.get(state).spec.config.clientID,
    get origins() { return this._origins || (this._origins = collabState.unconfirmed.map(s => s.origin)) }
  }
}

// :: (EditorState) → number
// Get the version up to which the collab plugin has synced with the
// central authority.
//
// @cn 获取 collab 插件与鉴权中心同步的版本。
export function getVersion(state) {
  return collabKey.getState(state).version
}

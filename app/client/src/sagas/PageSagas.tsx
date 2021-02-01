import CanvasWidgetsNormalizer from "normalizers/CanvasWidgetsNormalizer";
import { AppState } from "reducers";
import {
  Page,
  PageListPayload,
  ReduxAction,
  ReduxActionErrorTypes,
  ReduxActionTypes,
  UpdateCanvasPayload,
} from "constants/ReduxActionConstants";
import {
  clonePageSuccess,
  deletePageSuccess,
  FetchPageListPayload,
  fetchPageSuccess,
  fetchPublishedPageSuccess,
  savePageSuccess,
  setUrlData,
  initCanvasLayout,
  updateCurrentPage,
  updateWidgetNameSuccess,
} from "actions/pageActions";
import PageApi, {
  ClonePageRequest,
  CreatePageRequest,
  DeletePageRequest,
  FetchPageListResponse,
  FetchPageRequest,
  FetchPageResponse,
  FetchPublishedPageRequest,
  FetchPublishedPageResponse,
  PageLayout,
  SavePageResponse,
  UpdatePageRequest,
  UpdateWidgetNameRequest,
  UpdateWidgetNameResponse,
} from "api/PageApi";
import { FlattenedWidgetProps } from "reducers/entityReducers/canvasWidgetsReducer";
import {
  all,
  call,
  debounce,
  put,
  select,
  takeLatest,
  takeLeading,
} from "redux-saga/effects";
import history from "utils/history";
import { BUILDER_PAGE_URL } from "constants/routes";
import { isNameValid } from "utils/helpers";
import { extractCurrentDSL } from "utils/WidgetPropsUtils";
import {
  getAllPageIds,
  getEditorConfigs,
  getExistingPageNames,
  getWidgets,
} from "./selectors";
import { getDataTree } from "selectors/dataTreeSelectors";
import { validateResponse } from "./ErrorSagas";
import { executePageLoadActions } from "actions/widgetActions";
import { ApiResponse } from "api/ApiResponses";
import {
  getCurrentApplicationId,
  getCurrentLayoutId,
  getCurrentPageId,
  getCurrentPageName,
} from "selectors/editorSelectors";
import {
  fetchActionsForPage,
  setActionsToExecuteOnPageLoad,
} from "actions/actionActions";
import { APP_MODE, UrlDataState } from "reducers/entityReducers/appReducer";
import { clearEvalCache } from "./EvaluationsSaga";
import { getQueryParams } from "utils/AppsmithUtils";
import PerformanceTracker, {
  PerformanceTransactionName,
} from "utils/PerformanceTracker";
import log from "loglevel";

const getWidgetName = (state: AppState, widgetId: string) =>
  state.entities.canvasWidgets[widgetId];

export function* fetchPageListSaga(
  fetchPageListAction: ReduxAction<FetchPageListPayload>,
) {
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.FETCH_PAGE_LIST_API,
  );
  try {
    const { applicationId, mode } = fetchPageListAction.payload;
    const apiCall =
      mode === APP_MODE.EDIT
        ? PageApi.fetchPageList
        : PageApi.fetchPageListViewMode;
    const response: FetchPageListResponse = yield call(apiCall, applicationId);
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      const orgId = response.data.organizationId;
      const pages: PageListPayload = response.data.pages.map((page) => ({
        pageName: page.name,
        pageId: page.id,
        isDefault: page.isDefault,
      }));
      yield put({
        type: ReduxActionTypes.SET_CURRENT_ORG_ID,
        payload: {
          orgId,
        },
      });
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_LIST_SUCCESS,
        payload: {
          pages,
          applicationId,
        },
      });
      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.FETCH_PAGE_LIST_API,
      );
    } else {
      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.FETCH_PAGE_LIST_API,
      );
      yield put({
        type: ReduxActionErrorTypes.FETCH_PAGE_LIST_ERROR,
        payload: {
          error: response.responseMeta.error,
        },
      });
    }
  } catch (error) {
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_LIST_API,
      { failed: true },
    );
    yield put({
      type: ReduxActionErrorTypes.FETCH_PAGE_LIST_ERROR,
      payload: {
        error,
      },
    });
  }
}

const getCanvasWidgetsPayload = (
  pageResponse: FetchPageResponse,
): UpdateCanvasPayload => {
  const normalizedResponse = CanvasWidgetsNormalizer.normalize(
    extractCurrentDSL(pageResponse),
  );
  return {
    pageWidgetId: normalizedResponse.result,
    currentPageName: pageResponse.data.name,
    currentPageId: pageResponse.data.id,
    widgets: normalizedResponse.entities.canvasWidgets,
    currentLayoutId: pageResponse.data.layouts[0].id, // TODO(abhinav): Handle for multiple layouts
    currentApplicationId: pageResponse.data.applicationId,
    pageActions: pageResponse.data.layouts[0].layoutOnLoadActions || [],
  };
};

export function* fetchPageSaga(
  pageRequestAction: ReduxAction<FetchPageRequest>,
) {
  try {
    const { id } = pageRequestAction.payload;
    PerformanceTracker.startAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      { pageId: id },
    );
    const fetchPageResponse: FetchPageResponse = yield call(PageApi.fetchPage, {
      id,
    });
    const isValidResponse = yield validateResponse(fetchPageResponse);
    if (isValidResponse) {
      // Clear any existing caches
      yield call(clearEvalCache);
      // Set url params
      yield call(setDataUrl);
      // Get Canvas payload
      const canvasWidgetsPayload = getCanvasWidgetsPayload(fetchPageResponse);
      // Update the canvas
      yield put(initCanvasLayout(canvasWidgetsPayload));
      // set current page
      yield put(updateCurrentPage(id));
      // dispatch fetch page success
      yield put(
        fetchPageSuccess([
          // Execute page load actions after evaluation of fetch page
          executePageLoadActions(canvasWidgetsPayload.pageActions),
        ]),
      );

      yield put({
        type: ReduxActionTypes.UPDATE_CANVAS_STRUCTURE,
        payload: extractCurrentDSL(fetchPageResponse),
      });

      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.FETCH_PAGE_API,
      );
    }
  } catch (error) {
    log.error(error);
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      {
        failed: true,
      },
    );
    yield put({
      type: ReduxActionErrorTypes.FETCH_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* fetchPublishedPageSaga(
  pageRequestAction: ReduxAction<{ pageId: string; bustCache: boolean }>,
) {
  try {
    const { pageId, bustCache } = pageRequestAction.payload;
    PerformanceTracker.startAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      { pageId: pageId, published: true },
    );
    const request: FetchPublishedPageRequest = {
      pageId,
      bustCache,
    };
    const response: FetchPublishedPageResponse = yield call(
      PageApi.fetchPublishedPage,
      request,
    );
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      // Clear any existing caches
      yield call(clearEvalCache);
      // Set url params
      yield call(setDataUrl);
      // Get Canvas payload
      const canvasWidgetsPayload = getCanvasWidgetsPayload(response);
      // Update the canvas
      yield put(initCanvasLayout(canvasWidgetsPayload));
      // set current page
      yield put(updateCurrentPage(pageId));
      // dispatch fetch page success
      yield put(
        fetchPublishedPageSuccess(
          {
            dsl: response.data.layouts[0].dsl,
            pageId: request.pageId,
            pageWidgetId: canvasWidgetsPayload.pageWidgetId,
          },
          // Execute page load actions post published page eval
          [executePageLoadActions(canvasWidgetsPayload.pageActions)],
        ),
      );
      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.FETCH_PAGE_API,
      );
    }
  } catch (error) {
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      {
        failed: true,
      },
    );
    yield put({
      type: ReduxActionErrorTypes.FETCH_PUBLISHED_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* fetchAllPublishedPagesSaga() {
  try {
    const pageIds = yield select(getAllPageIds);
    yield all(
      pageIds.map((pageId: string) => {
        return call(PageApi.fetchPublishedPage, { pageId });
      }),
    );
  } catch (error) {
    log.error({ error });
  }
}

function* savePageSaga() {
  const widgets = yield select(getWidgets);
  const editorConfigs = yield select(getEditorConfigs) as any;
  const savePageRequest = getLayoutSavePayload(widgets, editorConfigs);
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.SAVE_PAGE_API,
    {
      pageId: savePageRequest.pageId,
    },
  );
  try {
    // Store the updated DSL in the pageDSLs reducer
    yield put({
      type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
      payload: {
        pageId: savePageRequest.pageId,
        dsl: savePageRequest.dsl,
      },
    });

    yield put({
      type: ReduxActionTypes.UPDATE_CANVAS_STRUCTURE,
      payload: savePageRequest.dsl,
    });

    const savePageResponse: SavePageResponse = yield call(
      PageApi.savePage,
      savePageRequest,
    );
    const isValidResponse = yield validateResponse(savePageResponse);
    if (isValidResponse) {
      if (
        savePageResponse.data.layoutOnLoadActions &&
        savePageResponse.data.layoutOnLoadActions.length > 0
      ) {
        for (const actionSet of savePageResponse.data.layoutOnLoadActions) {
          yield put(setActionsToExecuteOnPageLoad(actionSet.map((a) => a.id)));
        }
      }
      yield put(savePageSuccess(savePageResponse));
      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.SAVE_PAGE_API,
      );
    }
  } catch (error) {
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.SAVE_PAGE_API,
      {
        failed: true,
      },
    );

    yield put({
      type: ReduxActionErrorTypes.SAVE_PAGE_ERROR,
      payload: {
        error,
        show: false,
      },
    });
  }
}

function getLayoutSavePayload(
  widgets: {
    [widgetId: string]: FlattenedWidgetProps;
  },
  editorConfigs: any,
) {
  const denormalizedDSL = CanvasWidgetsNormalizer.denormalize(
    Object.keys(widgets)[0],
    { canvasWidgets: widgets },
  );
  return {
    ...editorConfigs,
    dsl: denormalizedDSL,
  };
}

export function* saveLayoutSaga() {
  try {
    yield put({
      type: ReduxActionTypes.SAVE_PAGE_INIT,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.SAVE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* createPageSaga(
  createPageAction: ReduxAction<CreatePageRequest>,
) {
  try {
    const request: CreatePageRequest = createPageAction.payload;
    const response: FetchPageResponse = yield call(PageApi.createPage, request);
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      yield put({
        type: ReduxActionTypes.CREATE_PAGE_SUCCESS,
        payload: {
          pageId: response.data.id,
          pageName: response.data.name,
          layoutId: response.data.layouts[0].id,
        },
      });
      // Add this to the page DSLs for entity explorer
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: response.data.id,
          dsl: extractCurrentDSL(response),
        },
      });
      history.push(
        BUILDER_PAGE_URL(
          createPageAction.payload.applicationId,
          response.data.id,
        ),
      );
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CREATE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* updatePageSaga(action: ReduxAction<UpdatePageRequest>) {
  try {
    const request: UpdatePageRequest = action.payload;
    const response: ApiResponse = yield call(PageApi.updatePage, request);
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      yield put({
        type: ReduxActionTypes.UPDATE_PAGE_SUCCESS,
        payload: action.payload,
      });
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.UPDATE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* deletePageSaga(action: ReduxAction<DeletePageRequest>) {
  try {
    const request: DeletePageRequest = action.payload;
    const defaultPageId = yield select(
      (state: AppState) => state.entities.pageList.defaultPageId,
    );
    const applicationId = yield select(
      (state: AppState) => state.entities.pageList.applicationId,
    );
    if (defaultPageId === request.id) {
      throw Error("Cannot delete the home page.");
    } else {
      const response: ApiResponse = yield call(PageApi.deletePage, request);
      const isValidResponse = yield validateResponse(response);
      if (isValidResponse) {
        yield put(deletePageSuccess());
      }
      // Remove this page from page DSLs
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: request.id,
          dsl: undefined,
        },
      });
      const currentPageId = yield select(
        (state: AppState) => state.entities.pageList.currentPageId,
      );
      if (currentPageId === action.payload.id)
        history.push(BUILDER_PAGE_URL(applicationId, defaultPageId));
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.DELETE_PAGE_ERROR,
      payload: {
        error: { message: error.message, show: true },
        show: true,
      },
    });
  }
}

export function* clonePageSaga(clonePageAction: ReduxAction<ClonePageRequest>) {
  try {
    const request: ClonePageRequest = clonePageAction.payload;
    const response: FetchPageResponse = yield call(PageApi.clonePage, request);
    const applicationId = yield select(
      (state: AppState) => state.entities.pageList.applicationId,
    );
    const isValidResponse = yield validateResponse(response);
    if (isValidResponse) {
      yield put(
        clonePageSuccess(
          response.data.id,
          response.data.name,
          response.data.layouts[0].id,
        ),
      );
      // Add this to the page DSLs for entity explorer
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: response.data.id,
          dsl: extractCurrentDSL(response),
        },
      });

      yield put(fetchActionsForPage(response.data.id));

      history.push(BUILDER_PAGE_URL(applicationId, response.data.id));
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CLONE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

/**
 * this saga do two things
 *
 * 1. Checks if the name of page is conflicting with any used name
 * 2. dispatches a action which triggers a request to update the name
 *
 * @param action
 */
export function* updateWidgetNameSaga(
  action: ReduxAction<{ id: string; newName: string }>,
) {
  try {
    const { widgetName } = yield select(getWidgetName, action.payload.id);
    const layoutId = yield select(getCurrentLayoutId);
    const evalTree = yield select(getDataTree);
    const pageId = yield select(getCurrentPageId);
    const existingPageNames = yield select(getExistingPageNames);

    // check if name is not conflicting with any
    // existing entity/api/queries/reserved words
    if (
      isNameValid(action.payload.newName, {
        ...evalTree,
        ...existingPageNames,
      })
    ) {
      const request: UpdateWidgetNameRequest = {
        newName: action.payload.newName,
        oldName: widgetName,
        pageId,
        layoutId,
      };
      const response: UpdateWidgetNameResponse = yield call(
        PageApi.updateWidgetName,
        request,
      );
      const isValidResponse = yield validateResponse(response);
      if (isValidResponse) {
        yield updateCanvasWithDSL(response.data, pageId, layoutId);

        yield put(updateWidgetNameSuccess());
        // Add this to the page DSLs for entity explorer
        yield put({
          type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
          payload: {
            pageId: pageId,
            dsl: response.data.dsl,
          },
        });
      }
    } else {
      yield put({
        type: ReduxActionErrorTypes.UPDATE_WIDGET_NAME_ERROR,
        payload: {
          error: {
            message: `Entity name: ${action.payload.newName} is already being used.`,
          },
        },
      });
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.UPDATE_WIDGET_NAME_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* updateCanvasWithDSL(
  data: PageLayout,
  pageId: string,
  layoutId: string,
) {
  const normalizedWidgets = CanvasWidgetsNormalizer.normalize(data.dsl);
  const currentPageName = yield select(getCurrentPageName);
  const applicationId = yield select(getCurrentApplicationId);
  const canvasWidgetsPayload: UpdateCanvasPayload = {
    pageWidgetId: normalizedWidgets.result,
    currentPageName,
    currentPageId: pageId,
    currentLayoutId: layoutId,
    currentApplicationId: applicationId,
    pageActions: data.layoutOnLoadActions,
    widgets: normalizedWidgets.entities.canvasWidgets,
  };
  yield put(initCanvasLayout(canvasWidgetsPayload));
  yield put(fetchActionsForPage(pageId));
}

export function* setDataUrl() {
  const urlData: UrlDataState = {
    fullPath: window.location.href,
    host: window.location.host,
    hostname: window.location.hostname,
    queryParams: getQueryParams(),
    protocol: window.location.protocol,
    pathname: window.location.pathname,
    port: window.location.port,
    hash: window.location.hash,
  };
  yield put(setUrlData(urlData));
}

function* fetchPageDSLSaga(pageId: string) {
  try {
    const fetchPageResponse: FetchPageResponse = yield call(PageApi.fetchPage, {
      id: pageId,
    });
    const isValidResponse = yield validateResponse(fetchPageResponse);
    if (isValidResponse) {
      return {
        pageId: pageId,
        dsl: extractCurrentDSL(fetchPageResponse),
      };
    }
  } catch (error) {
    yield put({
      type: ReduxActionTypes.FETCH_PAGE_DSL_ERROR,
      payload: {
        pageId: pageId,
        error,
        show: false,
      },
    });
  }
}

export function* populatePageDSLsSaga() {
  try {
    yield put({
      type: ReduxActionTypes.POPULATE_PAGEDSLS_INIT,
    });
    const pageIds: string[] = yield select((state: AppState) =>
      state.entities.pageList.pages.map((page: Page) => page.pageId),
    );
    const pageDSLs = yield all(
      pageIds.map((pageId: string) => {
        return call(fetchPageDSLSaga, pageId);
      }),
    );
    yield put({
      type: ReduxActionTypes.FETCH_PAGE_DSLS_SUCCESS,
      payload: pageDSLs,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.POPULATE_PAGEDSLS_ERROR,
      payload: {
        error,
      },
    });
  }
}

export default function* pageSagas() {
  yield all([
    takeLatest(ReduxActionTypes.FETCH_PAGE_INIT, fetchPageSaga),
    takeLatest(
      ReduxActionTypes.FETCH_PUBLISHED_PAGE_INIT,
      fetchPublishedPageSaga,
    ),
    takeLatest(ReduxActionTypes.UPDATE_LAYOUT, saveLayoutSaga),
    takeLeading(ReduxActionTypes.CREATE_PAGE_INIT, createPageSaga),
    takeLeading(ReduxActionTypes.CLONE_PAGE_INIT, clonePageSaga),
    takeLatest(ReduxActionTypes.FETCH_PAGE_LIST_INIT, fetchPageListSaga),
    takeLatest(ReduxActionTypes.UPDATE_PAGE_INIT, updatePageSaga),
    takeLatest(ReduxActionTypes.DELETE_PAGE_INIT, deletePageSaga),
    debounce(500, ReduxActionTypes.SAVE_PAGE_INIT, savePageSaga),
    takeLatest(ReduxActionTypes.UPDATE_WIDGET_NAME_INIT, updateWidgetNameSaga),
    takeLatest(
      ReduxActionTypes.FETCH_ALL_PUBLISHED_PAGES,
      fetchAllPublishedPagesSaga,
    ),
  ]);
}

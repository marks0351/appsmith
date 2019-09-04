package com.appsmith.server.exceptions;

import lombok.Getter;

import java.text.MessageFormat;

@Getter
public enum AppsmithError {

    NO_RESOURCE_FOUND(404, 1000, "Unable to find {0} with id {1}"),
    INVALID_PARAMETER(400, 4000, "Invalid parameter {0} provided in the input"),
    PLUGIN_NOT_INSTALLED(400, 4001, "Plugin not installed for organization {0}"),
    PLUGIN_ID_NOT_GIVEN(400, 4002, "Missing plugin id. Please input correct plugin id"),
    RESOURCE_ID_NOT_GIVEN(400, 4003, "Missing resource id. Please input correct resource id"),
    INTERNAL_SERVER_ERROR(500, 5000, "Internal server error while processing request");

    private Integer httpErrorCode;
    private Integer appErrorCode;
    private String message;

    private AppsmithError(Integer httpErrorCode, Integer appErrorCode, String message, Object... args) {
        this.httpErrorCode = httpErrorCode;
        this.appErrorCode = appErrorCode;
        MessageFormat fmt = new MessageFormat(message);
        this.message = fmt.format(args);
    }

    public String getMessage(Object... args) {
        return new MessageFormat(this.message).format(args);
    }

}

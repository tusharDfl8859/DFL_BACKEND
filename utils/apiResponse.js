/**
 * Standardized API Response Helper
 * Provides a clean, predictable envelope for all API responses:
 * {
 *   success: true/false,
 *   message: "Description",
 *   data: {...},
 *   statusCode: 200
 * }
 */
class ApiResponse {
    static success(res, data = {}, message = 'Operation successful', statusCode = 200) {
        return res.status(statusCode).json({
            success: true,
            statusCode,
            message,
            data
        });
    }

    static created(res, data = {}, message = 'Resource created successfully') {
        return ApiResponse.success(res, data, message, 201);
    }

    static error(res, message = 'An unexpected error occurred', statusCode = 500, errors = null) {
        const payload = {
            success: false,
            statusCode,
            message
        };
        if (errors) {
            payload.errors = errors;
        }
        return res.status(statusCode).json(payload);
    }

    static badRequest(res, message = 'Invalid request parameters', errors = null) {
        return ApiResponse.error(res, message, 400, errors);
    }

    static unauthorized(res, message = 'Authentication required. Please login.') {
        return ApiResponse.error(res, message, 401);
    }

    static forbidden(res, message = 'Access denied. You lack required permissions.') {
        return ApiResponse.error(res, message, 403);
    }

    static notFound(res, message = 'Requested resource not found') {
        return ApiResponse.error(res, message, 404);
    }

    static conflict(res, message = 'Resource already exists or conflict occurred') {
        return ApiResponse.error(res, message, 409);
    }
}

module.exports = ApiResponse;

import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "BwebDemoProject API",
      version: "1.0.0",
      description: "API documentation for BwebDemoProject Backend Server",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: "/api/v1",
        description: "API V1",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your JWT token",
        },
      },
      schemas: {
        // Common response schemas
        SuccessResponse: {
          type: "object",
          properties: {
            isOk: { type: "boolean", example: true },
            message: { type: "string" },
            data: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            isOk: { type: "boolean", example: false },
            message: { type: "string" },
          },
        },
        PaginatedResponse: {
          type: "object",
          properties: {
            isOk: { type: "boolean", example: true },
            data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  data: { type: "array", items: { type: "object" } },
                  count: { type: "integer" },
                },
              },
            },
          },
        },
        SearchParams: {
          type: "object",
          properties: {
            skip: {
              type: "integer",
              default: 0,
              description: "Number of records to skip",
            },
            per_page: {
              type: "integer",
              default: 10,
              description: "Records per page",
            },
            sorton: { type: "string", description: "Field to sort on" },
            sortdir: {
              type: "string",
              enum: ["asc", "desc"],
              description: "Sort direction",
            },
            match: { type: "string", description: "Search query" },
            isActive: {
              type: "boolean",
              description: "Filter by active status",
            },
          },
        },
        // Country schemas
        Country: {
          type: "object",
          properties: {
            _id: { type: "string" },
            countryName: { type: "string" },
            countryCode: { type: "string" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateCountry: {
          type: "object",
          required: ["countryName"],
          properties: {
            countryName: { type: "string", example: "India" },
            countryCode: { type: "string", example: "IN" },
            isActive: { type: "boolean", default: true },
          },
        },
        // State schemas
        State: {
          type: "object",
          properties: {
            _id: { type: "string" },
            stateName: { type: "string" },
            stateCode: { type: "string" },
            countryId: { type: "string" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateState: {
          type: "object",
          required: ["stateName", "countryId"],
          properties: {
            stateName: { type: "string", example: "Maharashtra" },
            stateCode: { type: "string", example: "MH" },
            countryId: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // City schemas
        City: {
          type: "object",
          properties: {
            _id: { type: "string" },
            cityName: { type: "string" },
            stateId: { type: "string" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CreateCity: {
          type: "object",
          required: ["cityName", "stateId"],
          properties: {
            cityName: { type: "string", example: "Mumbai" },
            stateId: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Currency schemas
        Currency: {
          type: "object",
          properties: {
            _id: { type: "string" },
            currencyName: { type: "string" },
            currencyCode: { type: "string" },
            currencySymbol: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateCurrency: {
          type: "object",
          required: ["currencyName", "currencyCode"],
          properties: {
            currencyName: { type: "string", example: "Indian Rupee" },
            currencyCode: { type: "string", example: "INR" },
            currencySymbol: { type: "string", example: "₹" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Role schemas
        Role: {
          type: "object",
          properties: {
            _id: { type: "string" },
            roleName: { type: "string" },
            description: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateRole: {
          type: "object",
          required: ["roleName"],
          properties: {
            roleName: { type: "string", example: "Manager" },
            description: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Menu Group schemas
        MenuGroup: {
          type: "object",
          properties: {
            _id: { type: "string" },
            menuGroupName: { type: "string" },
            icon: { type: "string" },
            displayOrder: { type: "integer" },
            isActive: { type: "boolean" },
          },
        },
        CreateMenuGroup: {
          type: "object",
          required: ["menuGroupName"],
          properties: {
            menuGroupName: { type: "string", example: "Master" },
            icon: { type: "string", example: "ri-settings-line" },
            displayOrder: { type: "integer", example: 1 },
            isActive: { type: "boolean", default: true },
          },
        },
        // Menu schemas
        Menu: {
          type: "object",
          properties: {
            _id: { type: "string" },
            menuName: { type: "string" },
            menuGroupId: { type: "string" },
            parentMenuId: { type: "string" },
            menuPath: { type: "string" },
            icon: { type: "string" },
            displayOrder: { type: "integer" },
            isActive: { type: "boolean" },
          },
        },
        CreateMenu: {
          type: "object",
          required: ["menuName", "menuGroupId"],
          properties: {
            menuName: { type: "string", example: "Country" },
            menuGroupId: { type: "string" },
            parentMenuId: { type: "string" },
            menuPath: { type: "string", example: "/master/country" },
            icon: { type: "string" },
            displayOrder: { type: "integer", example: 1 },
            isActive: { type: "boolean", default: true },
          },
        },
        // Department schemas
        Department: {
          type: "object",
          properties: {
            _id: { type: "string" },
            departmentName: { type: "string" },
            description: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateDepartment: {
          type: "object",
          required: ["departmentName"],
          properties: {
            departmentName: { type: "string", example: "Sales" },
            description: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Employee schemas
        Employee: {
          type: "object",
          properties: {
            _id: { type: "string" },
            employeeName: { type: "string" },
            emailOffice: { type: "string" },
            mobileNumber: { type: "string" },
            departmentId: { type: "string" },
            roleId: { type: "string" },
            countryId: { type: "string" },
            stateId: { type: "string" },
            cityId: { type: "string" },
            address: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateEmployee: {
          type: "object",
          required: ["employeeName", "emailOffice"],
          properties: {
            employeeName: { type: "string", example: "John Doe" },
            emailOffice: { type: "string", example: "john@example.com" },
            mobileNumber: { type: "string" },
            departmentId: { type: "string" },
            roleId: { type: "string" },
            password: { type: "string" },
            countryId: { type: "string" },
            stateId: { type: "string" },
            cityId: { type: "string" },
            address: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Employee Roles schemas
        EmployeeRoles: {
          type: "object",
          properties: {
            _id: { type: "string" },
            roleId: { type: "string" },
            roles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  menuId: { type: "string" },
                  read: { type: "boolean" },
                  write: { type: "boolean" },
                  edit: { type: "boolean" },
                  delete: { type: "boolean" },
                  print: { type: "boolean" },
                  mail: { type: "boolean" },
                },
              },
            },
          },
        },
        // Email Setup schemas
        EmailSetup: {
          type: "object",
          properties: {
            _id: { type: "string" },
            emailHost: { type: "string" },
            emailPort: { type: "integer" },
            emailUser: { type: "string" },
            emailPassword: { type: "string" },
            emailFrom: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateEmailSetup: {
          type: "object",
          required: ["emailHost", "emailPort", "emailUser"],
          properties: {
            emailHost: { type: "string", example: "smtp.gmail.com" },
            emailPort: { type: "integer", example: 587 },
            emailUser: { type: "string", example: "user@gmail.com" },
            emailPassword: { type: "string" },
            emailFrom: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Email For schemas
        EmailFor: {
          type: "object",
          properties: {
            _id: { type: "string" },
            emailForName: { type: "string" },
            description: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateEmailFor: {
          type: "object",
          required: ["emailForName"],
          properties: {
            emailForName: { type: "string", example: "Welcome Email" },
            description: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Email Template schemas
        EmailTemplate: {
          type: "object",
          properties: {
            _id: { type: "string" },
            templateName: { type: "string" },
            emailForId: { type: "string" },
            emailSetupId: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        CreateEmailTemplate: {
          type: "object",
          required: ["templateName", "emailForId"],
          properties: {
            templateName: { type: "string", example: "User Welcome" },
            emailForId: { type: "string" },
            emailSetupId: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            isActive: { type: "boolean", default: true },
          },
        },
        // Company schemas
        Company: {
          type: "object",
          properties: {
            _id: { type: "string" },
            companyName: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            address: { type: "string" },
            logo: { type: "string" },
            favicon: { type: "string" },
            isActive: { type: "boolean" },
          },
        },
        // Auth schemas
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", example: "admin@example.com" },
            password: { type: "string", example: "password123" },
          },
        },
        LoginResponse: {
          type: "object",
          properties: {
            isOk: { type: "boolean", example: true },
            message: { type: "string" },
            token: { type: "string" },
            role: { type: "string" },
            data: { type: "object" },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
    tags: [
      { name: "Auth", description: "Authentication endpoints" },
      { name: "Companies", description: "Company management" },
      { name: "Countries", description: "Country management" },
      { name: "States", description: "State management" },
      { name: "Cities", description: "City management" },
      { name: "Currencies", description: "Currency management" },
      { name: "Roles", description: "Role management" },
      { name: "Menu Groups", description: "Menu group management" },
      { name: "Menus", description: "Menu management" },
      { name: "Departments", description: "Department management" },
      { name: "Employees", description: "Employee management" },
      { name: "Employee Roles", description: "Employee role permissions" },
      { name: "Email Setup", description: "Email SMTP configuration" },
      { name: "Email For", description: "Email purpose/category management" },
      { name: "Email Templates", description: "Email template management" },
    ],
  },
  apis: ["./routes/v1/*.js"], // Path to the API routes
};

const swaggerSpec = swaggerJsdoc(options);

export const setupSwagger = (app) => {
  // Swagger UI route
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "BwebDemoProject API Documentation",
    }),
  );

  // Serve swagger spec as JSON
  app.get("/api-docs.json", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });

  console.log("📚 Swagger UI available at /api-docs");
};

export default swaggerSpec;
